import { createHmac } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { TwitchApi } from '../src/twitch/twitch-api.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

const password = 'correct horse battery staple';
const eventSubSecret = 'eventsub-secret-for-tests-0123456789';

describe('live dashboard', () => {
  let app: FastifyInstance;
  let store: ReturnType<typeof createInMemoryStore>;
  const openStreams: IncomingMessage[] = [];

  function build(environment: Record<string, string> = {}) {
    store = createInMemoryStore();
    app = buildApp(
      loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
        LOG_LEVEL: 'fatal',
        ADMIN_PASSWORD: password,
        TWITCH_CLIENT_ID: 'cid',
        TWITCH_CLIENT_SECRET: 'csecret',
        ...environment,
      }),
      {
        donations: store.donations,
        leaderboard: store.leaderboard,
        connections: store.connections,
        eventLog: store.eventLog,
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        adminSessionSecret: 'a'.repeat(64),
        twitch: { api: {} as TwitchApi, eventSubSecret },
      },
    );
  }

  afterEach(async () => {
    for (const stream of openStreams.splice(0)) stream.destroy();
    await app.close();
  });

  async function signIn(): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password }).toString(),
    });
    const cookie = response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin')!;
    return `${cookie.name}=${cookie.value}`;
  }

  async function openStream(cookie: string) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/admin/live/stream', headers: { cookie } }, resolve).on('error', reject).end();
    });
    openStreams.push(response);
    let received = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      received += chunk;
    });
    const blocks = (type: string) =>
      received
        .split('\n\n')
        .filter((block) => block.includes(`event: ${type}\n`))
        .map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));
    return {
      response,
      blocks,
      async waitFor(type: string, count = 1) {
        const deadline = Date.now() + 2000;
        while (blocks(type).length < count) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got:\n${received}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  }

  /** A follow delivered through the real Twitch webhook, signed as Twitch does. */
  async function deliverFollow(messageId: string, name: string) {
    const body = JSON.stringify({
      subscription: { type: 'channel.follow', version: '2', status: 'enabled' },
      event: { user_id: '9', user_login: name.toLowerCase(), user_name: name, broadcaster_user_id: '111', followed_at: 'now' },
    });
    const timestamp = new Date().toISOString();
    return app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-signature': `sha256=${createHmac('sha256', eventSubSecret).update(messageId + timestamp + body).digest('hex')}`,
        'twitch-eventsub-message-type': 'notification',
      },
      payload: body,
    });
  }

  it('requires the admin session for the page and its stream', async () => {
    build();
    for (const url of ['/admin/live', '/admin/live/stream']) {
      expect((await app.inject({ method: 'GET', url })).headers.location, url).toBe('/admin/login');
    }
  });

  it('serves the page with its own script allowed, and links to it from the admin page', async () => {
    build();
    const cookie = await signIn();
    const page = await app.inject({ method: 'GET', url: '/admin/live', headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<script type="module" src="/static/admin-live.js">');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain('https://static-cdn.jtvnw.net https://files.kick.com');
    expect((await app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body).toContain('href="/admin/live"');
    expect((await app.inject({ method: 'GET', url: '/static/admin-live.js' })).statusCode).toBe(200);
  });

  it('starts with recent events and paid donations, newest first, then streams new ones', async () => {
    build();
    store.connections.connect('twitch', '111', 'machinearash');
    store.eventLog.record({ platform: 'kick', kind: 'kicks', actorName: 'kicker', kicks: 100, message: 'gg' }, 'kick-old');
    const donation = store.donations.create({ donorName: 'Ann', message: 'love it', amountMinor: 500, currency: 'usd' });
    store.donations.setInvoiceId(donation.publicId, 'inv');
    store.donations.applyPaymentUpdate(
      donation.publicId,
      { status: 'finished', paymentId: 'p', invoiceId: 'inv', payCurrency: 'ltc', actuallyPaid: '1' },
      'confirmed',
    );
    const unpaid = store.donations.create({ donorName: 'Unpaid', message: '', amountMinor: 500, currency: 'usd' });

    const stream = await openStream(await signIn());
    await stream.waitFor('snapshot');
    const [snapshot] = stream.blocks('snapshot');
    expect(snapshot.map((item: { source: string }) => item.source).sort()).toEqual(['donation', 'kick']);
    expect(snapshot).toContainEqual(
      expect.objectContaining({ source: 'donation', message: 'love it', headline: [{ text: 'Ann donated ', emphasis: false }, { text: '$5.00', emphasis: true }] }),
    );
    expect(snapshot).toContainEqual(expect.objectContaining({ id: 'kick-old', source: 'kick', message: 'gg' }));
    expect(JSON.stringify(snapshot)).not.toContain(unpaid.publicId);
    await stream.waitFor('chat-snapshot');
    expect(stream.blocks('chat-snapshot')).toEqual([[]]);

    await deliverFollow('m1', 'NeonRider');
    await stream.waitFor('activity');
    expect(stream.blocks('activity')).toEqual([
      expect.objectContaining({ id: 'twitch-m1', source: 'twitch', headline: [{ text: 'NeonRider just followed', emphasis: false }] }),
    ]);
    expect(store.eventLog.recent(10).map((event) => event.alertId)).toContain('twitch-m1');
  });

  it('sends the last known stream status on connect, and asks for a fresh one', async () => {
    store = createInMemoryStore();
    let refreshes = 0;
    app = buildApp(
      loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
        LOG_LEVEL: 'fatal',
        ADMIN_PASSWORD: password,
      }),
      {
        donations: store.donations,
        leaderboard: store.leaderboard,
        connections: store.connections,
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        adminSessionSecret: 'a'.repeat(64),
        streamStatus: {
          current: () => [{ platform: 'twitch', state: 'live', login: 'machinearash', viewers: 42, startedAt: 't0', title: 'chill' }],
          refresh: async () => void refreshes++,
        },
      },
    );
    const stream = await openStream(await signIn());
    await stream.waitFor('status');
    expect(stream.blocks('status')[0]).toEqual([
      { platform: 'twitch', state: 'live', login: 'machinearash', viewers: 42, startedAt: 't0', title: 'chill' },
    ]);
    expect(refreshes).toBe(1);
  });

  it('clears chat from the dashboard, only for a signed-in admin', async () => {
    build();
    let cleared = 0;
    await app.close();
    store = createInMemoryStore();
    app = buildApp(
      loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
        LOG_LEVEL: 'fatal',
        ADMIN_PASSWORD: password,
      }),
      {
        donations: store.donations,
        leaderboard: store.leaderboard,
        connections: store.connections,
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        adminSessionSecret: 'a'.repeat(64),
        chat: { add: () => {}, remove: () => {}, recent: () => [], clear: () => void cleared++ },
      },
    );
    const signedOut = await app.inject({ method: 'POST', url: '/admin/live/chat/clear' });
    expect(signedOut.headers.location).toBe('/admin/login');
    expect(cleared).toBe(0);
    const cookie = await signIn();
    const page = await app.inject({ method: 'GET', url: '/admin/live', headers: { cookie } });
    expect(page.body).toContain('action="/admin/live/chat/clear"');
    const response = await app.inject({ method: 'POST', url: '/admin/live/chat/clear', headers: { cookie } });
    expect(response.headers.location).toBe('/admin/live');
    expect(cleared).toBe(1);
  });

  it('still records an event whose alert is switched off', async () => {
    build({ EVENT_ALERTS: 'none' });
    store.connections.connect('twitch', '111', 'machinearash');
    const stream = await openStream(await signIn());
    await stream.waitFor('snapshot');
    await deliverFollow('m2', 'Quiet');
    await stream.waitFor('activity');
    expect(stream.blocks('activity')[0]).toMatchObject({ id: 'twitch-m2' });
  });

  it('never records test-page events', async () => {
    build();
    const cookie = await signIn();
    await app.inject({
      method: 'POST',
      url: '/overlay/overlay-token-for-tests-0123456789/test/event',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: 'kind=follow&platform=twitch',
    });
    expect(store.eventLog.recent(10)).toEqual([]);
  });
});
