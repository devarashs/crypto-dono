import { createInMemoryStore } from './support/in-memory-store.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createAlertHub, type AlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { createDonationRepository, type DonationRepository } from '../src/donations/donation-repository.ts';

const password = 'correct horse battery staple';
const token = 'overlay-token-for-tests-0123456789';

type Context = {
  app: FastifyInstance;
  donations: DonationRepository;
  alertHub: AlertHub;
  published: OverlayAlert[];
};

function build(environment: Record<string, string> = {}): Context {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'https://dono.example.com',
    NOWPAYMENTS_API_KEY: 'k',
    NOWPAYMENTS_IPN_SECRET: 's',
    OVERLAY_TOKEN: token,
    LOG_LEVEL: 'fatal',
    ADMIN_PASSWORD: password,
    BANNED_WORDS: 'darn',
    ...environment,
  });
  const { donations, leaderboard, connections } = createInMemoryStore();
  const alertHub = createAlertHub();
  const published: OverlayAlert[] = [];
  alertHub.subscribe((alert) => published.push(alert));
  const app = buildApp(config, {
    donations,
    leaderboard,
    connections,
    nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
    alertHub,
    ...(config.adminPassword !== null && { adminSessionSecret: 'a'.repeat(64) }),
  });
  return { app, donations, alertHub, published };
}

function paidDonation(donations: DonationRepository, donorName: string, message = ''): string {
  const { publicId } = donations.create({ donorName, message, amountMinor: 500, currency: 'usd' });
  donations.applyPaymentUpdate(
    publicId,
    { status: 'finished', paymentId: `p-${donorName}`, invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
    'confirmed',
  );
  return publicId;
}

function form(fields: Record<string, string>) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

function sessionCookie(response: LightMyRequestResponse): string {
  const cookie = response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin');
  if (cookie === undefined) throw new Error('no session cookie set');
  return `${cookie.name}=${cookie.value}`;
}

async function signIn(app: FastifyInstance, remoteAddress = '203.0.113.9'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/admin/login', remoteAddress, ...form({ password }) });
  expect(response.statusCode).toBe(303);
  return sessionCookie(response);
}

describe('admin routes', () => {
  let context: Context | undefined;
  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it('does not exist without ADMIN_PASSWORD', async () => {
    context = build({ ADMIN_PASSWORD: '' });
    for (const [method, url] of [
      ['GET', '/admin'],
      ['GET', '/admin/login'],
      ['POST', '/admin/login'],
    ] as const) {
      expect((await context.app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('sends a signed-out visitor to the sign-in page', async () => {
    context = build();
    const response = await context.app.inject({ method: 'GET', url: '/admin' });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/admin/login');
  });

  it('rejects a wrong password without starting a session', async () => {
    context = build();
    const response = await context.app.inject({ method: 'POST', url: '/admin/login', ...form({ password: 'nope' }) });
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain('That password is not right.');
    expect(response.cookies).toEqual([]);
  });

  it('treats a missing password field as wrong', async () => {
    context = build();
    expect((await context.app.inject({ method: 'POST', url: '/admin/login', ...form({}) })).statusCode).toBe(401);
  });

  it('signs in with a scoped HttpOnly cookie and shows the dashboard', async () => {
    context = build();
    paidDonation(context.donations, 'Ann', 'darn good stream');
    const response = await context.app.inject({ method: 'POST', url: '/admin/login', ...form({ password }) });
    expect(response.headers.location).toBe('/admin');
    const cookie = response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin');
    // Plain HTTP: @fastify/session lowers SameSite to Lax with secure 'auto'. Lax
    // still withholds the cookie from cross-site POSTs, which is what matters here.
    expect(cookie).toMatchObject({ path: '/admin', httpOnly: true, sameSite: 'Lax' });

    const dashboard = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie: sessionCookie(response) } });
    expect(dashboard.statusCode).toBe(200);
    // The admin sees what the donor actually wrote, unfiltered.
    expect(dashboard.body).toContain('darn good stream');
    expect(dashboard.body).toContain(`https://dono.example.com/overlay/${token}`);
    expect(dashboard.body).toContain(`https://dono.example.com/overlay/${token}/board`);
    expect(dashboard.body).toContain(`https://dono.example.com/overlay/${token}/scene/starting-soon?minutes=5`);
    expect(dashboard.body).toContain(`https://dono.example.com/overlay/${token}/scene/ending-soon`);
    expect(dashboard.body).toContain(`/overlay/${token}/test`);
  });

  it('marks the session cookie Secure and SameSite=Strict over HTTPS through a proxy', async () => {
    context = build();
    const response = await context.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
      payload: new URLSearchParams({ password }).toString(),
    });
    expect(response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin')).toMatchObject({
      secure: true,
      sameSite: 'Strict',
    });
  });

  it('rate-limits password guesses to 5 a minute per client', async () => {
    context = build();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/admin/login',
        remoteAddress: '198.51.100.20',
        ...form({ password: `guess-${attempt}` }),
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await context.app.inject({
      method: 'POST',
      url: '/admin/login',
      remoteAddress: '198.51.100.20',
      ...form({ password }),
    });
    expect(limited.statusCode).toBe(429);
  });

  it('ends the session on sign-out, so the old cookie stops working', async () => {
    context = build();
    const cookie = await signIn(context.app);
    const logout = await context.app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie } });
    expect(logout.headers.location).toBe('/admin/login');
    const after = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(after.statusCode).toBe(303);
    expect(after.headers.location).toBe('/admin/login');
  });

  it('rejects a forged cookie', async () => {
    context = build();
    const response = await context.app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: 'crypto_dono_admin=forged-session-id.signature' },
    });
    expect(response.statusCode).toBe(303);
  });

  it('never sets a session cookie on public pages', async () => {
    context = build();
    for (const url of ['/', '/thanks', '/admin/login']) {
      expect((await context.app.inject({ method: 'GET', url })).cookies, url).toEqual([]);
    }
  });

  describe('history', () => {
    it('lists paid donations by default and all of them on request', async () => {
      context = build();
      paidDonation(context.donations, 'Paid Pat');
      context.donations.create({ donorName: 'Abandoned Al', message: '', amountMinor: 500, currency: 'usd' });
      const cookie = await signIn(context.app);

      const paidOnly = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
      expect(paidOnly.body).toContain('Paid Pat');
      expect(paidOnly.body).not.toContain('Abandoned Al');

      const all = await context.app.inject({ method: 'GET', url: '/admin?all=1', headers: { cookie } });
      expect(all.body).toContain('Abandoned Al');
      expect(all.body).toContain('Checkout not started');
    });

    it('pages through history 25 at a time', async () => {
      context = build();
      for (let index = 1; index <= 30; index += 1) paidDonation(context.donations, `Donor ${index}`);
      const cookie = await signIn(context.app);

      const first = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
      expect(first.body).toContain('Donor 30');
      expect(first.body).not.toContain('Donor 5<');
      const olderLink = /href="(\/admin\?before=\d+)"/.exec(first.body)?.[1];
      expect(olderLink).toBeDefined();

      const second = await context.app.inject({ method: 'GET', url: olderLink ?? '', headers: { cookie } });
      expect(second.body).toContain('Donor 5<');
      expect(second.body).not.toContain('Older donations');
    });

    it('marks donations whose donor opted out of the leaderboard', async () => {
      context = build();
      const { publicId } = context.donations.create({
        donorName: 'Private Pat',
        message: '',
        amountMinor: 500,
        currency: 'usd',
        showOnLeaderboard: false,
      });
      context.donations.applyPaymentUpdate(
        publicId,
        { status: 'finished', paymentId: 'p', invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
        'confirmed',
      );
      paidDonation(context.donations, 'Public Pam');
      const cookie = await signIn(context.app);
      const body = (await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body;
      expect(body.match(/Hidden from leaderboard/g)).toHaveLength(1);
      expect(body.indexOf('Hidden from leaderboard')).toBeGreaterThan(body.indexOf('Private Pat'));
    });

    it('shows the empty state', async () => {
      context = build();
      const cookie = await signIn(context.app);
      const response = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
      expect(response.body).toContain('No paid donations yet.');
    });

    it('shows only fixed notices, never text taken from the URL', async () => {
      context = build();
      const cookie = await signIn(context.app);
      const known = await context.app.inject({ method: 'GET', url: '/admin?notice=skipped', headers: { cookie } });
      expect(known.body).toContain('Alert skipped.');
      const injected = await context.app.inject({
        method: 'GET',
        url: '/admin?notice=%3Cscript%3Ealert(1)%3C/script%3E',
        headers: { cookie },
      });
      expect(injected.body).not.toContain('<script>');
      expect(injected.body).not.toContain('role="status"');
    });
  });

  describe('alert controls', () => {
    it('replays an alert through the current filters', async () => {
      context = build();
      const id = paidDonation(context.donations, 'Ann', 'darn good');
      const cookie = await signIn(context.app);
      const response = await context.app.inject({ method: 'POST', url: `/admin/donations/${id}/replay`, headers: { cookie } });
      expect(response.headers.location).toBe('/admin?notice=replayed');
      expect(context.published).toEqual([
        { id, donorName: 'Ann', message: '**** good', amount: '$5.00', speak: false, replay: true },
      ]);
    });

    it('refuses to replay an unpaid donation', async () => {
      context = build();
      const { publicId } = context.donations.create({ donorName: 'X', message: '', amountMinor: 500, currency: 'usd' });
      const cookie = await signIn(context.app);
      const response = await context.app.inject({
        method: 'POST',
        url: `/admin/donations/${publicId}/replay`,
        headers: { cookie },
      });
      expect(response.headers.location).toBe('/admin?notice=no-alert');
      expect(context.published).toEqual([]);
    });

    it('skips an alert: marks it shown and tells overlays to drop it', async () => {
      context = build();
      const id = paidDonation(context.donations, 'Ann');
      const skipped = vi.fn();
      context.alertHub.subscribeToSkips(skipped);
      const cookie = await signIn(context.app);

      const response = await context.app.inject({ method: 'POST', url: `/admin/donations/${id}/skip`, headers: { cookie } });

      expect(response.headers.location).toBe('/admin?notice=skipped');
      expect(skipped).toHaveBeenCalledWith(id);
      expect(context.donations.findByPublicId(id)?.alertShownAt).not.toBeNull();
      expect(context.donations.listPendingAlerts('1970-01-01T00:00:00.000Z')).toEqual([]);
    });

    it('reports an unknown donation', async () => {
      context = build();
      const cookie = await signIn(context.app);
      for (const action of ['replay', 'skip']) {
        const response = await context.app.inject({ method: 'POST', url: `/admin/donations/nope/${action}`, headers: { cookie } });
        expect(response.headers.location, action).toBe('/admin?notice=not-found');
      }
    });

    it('refuses both actions without a session', async () => {
      context = build();
      const id = paidDonation(context.donations, 'Ann');
      const skipped = vi.fn();
      context.alertHub.subscribeToSkips(skipped);
      for (const action of ['replay', 'skip']) {
        const response = await context.app.inject({ method: 'POST', url: `/admin/donations/${id}/${action}` });
        expect(response.headers.location, action).toBe('/admin/login');
      }
      expect(context.published).toEqual([]);
      expect(skipped).not.toHaveBeenCalled();
      expect(context.donations.findByPublicId(id)?.alertShownAt).toBeNull();
    });
  });
});
