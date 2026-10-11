import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createAlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { TwitchApi } from '../src/twitch/twitch-api.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

const secret = 'eventsub-secret-for-tests-0123456789';
const password = 'correct horse battery staple';
const broadcasterId = '111';

type Context = {
  app: FastifyInstance;
  store: ReturnType<typeof createInMemoryStore>;
  published: OverlayAlert[];
  api: TwitchApi & { [K in keyof TwitchApi]: ReturnType<typeof vi.fn> };
};

function build(environment: Record<string, string> = {}, withTwitch = true): Context {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'https://dono.example.com',
    NOWPAYMENTS_API_KEY: 'k',
    NOWPAYMENTS_IPN_SECRET: 's',
    OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
    LOG_LEVEL: 'fatal',
    ADMIN_PASSWORD: password,
    ...(withTwitch && { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret' }),
    ...environment,
  });
  const store = createInMemoryStore();
  const alertHub = createAlertHub();
  const published: OverlayAlert[] = [];
  alertHub.subscribe((alert) => published.push(alert));
  const api = {
    authorizeUrl: vi.fn((redirectUri: string, state: string) => `https://id.twitch.tv/oauth2/authorize?state=${state}&redirect_uri=${redirectUri}`),
    identifyStreamer: vi.fn(async () => ({ id: broadcasterId, login: 'machinearash' })),
    listSubscriptions: vi.fn(async () => []),
    deleteSubscription: vi.fn(async () => {}),
    createSubscription: vi.fn(async (subscription: { type: string }) => ({ id: 'x', type: subscription.type, status: 'pending', callback: null })),
  } as unknown as Context['api'];
  const app = buildApp(config, {
    donations: store.donations,
    leaderboard: store.leaderboard,
    connections: store.connections,
    nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
    alertHub,
    adminSessionSecret: 'a'.repeat(64),
    ...(withTwitch && { twitch: { api, eventSubSecret: secret } }),
  });
  return { app, store, published, api };
}

/** A webhook request signed exactly as Twitch documents. */
function deliver(
  context: Context,
  type: string,
  payload: Record<string, unknown>,
  options: { messageId?: string; timestamp?: string; signWith?: string } = {},
) {
  const messageId = options.messageId ?? `msg-${Math.random()}`;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', options.signWith ?? secret).update(messageId + timestamp + body).digest('hex')}`;
  return context.app.inject({
    method: 'POST',
    url: '/webhooks/twitch',
    headers: {
      'content-type': 'application/json',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-signature': signature,
      'twitch-eventsub-message-type': type,
    },
    payload: body,
  });
}

const followEvent = (broadcaster = broadcasterId) => ({
  subscription: { type: 'channel.follow', version: '2', status: 'enabled' },
  event: { user_id: '9', user_login: 'neon', user_name: 'NeonRider', broadcaster_user_id: broadcaster, followed_at: 'now' },
});

async function signIn(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ password }).toString(),
  });
  const cookie = response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin')!;
  return `${cookie.name}=${cookie.value}`;
}

const stateFrom = (response: LightMyRequestResponse) => new URL(response.headers.location as string).searchParams.get('state') ?? '';

describe('Twitch webhook', () => {
  let context: Context | undefined;
  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it('answers the verification challenge with the raw value as plain text', async () => {
    context = build();
    const response = await deliver(context, 'webhook_callback_verification', {
      subscription: { type: 'channel.follow', status: 'webhook_callback_verification_pending' },
      challenge: 'pogchamp-kappa-360noscope',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.body).toBe('pogchamp-kappa-360noscope');
  });

  it('publishes a follow for the connected channel, once, however often it is delivered', async () => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    const first = await deliver(context, 'notification', followEvent(), { messageId: 'same' });
    const again = await deliver(context, 'notification', followEvent(), { messageId: 'same' });
    expect([first.statusCode, again.statusCode]).toEqual([204, 204]);
    expect(context.published).toHaveLength(1);
    expect(context.published[0]).toMatchObject({ id: 'twitch-same', kind: 'follow', donorName: 'NeonRider', badge: { label: 'Twitch' } });
  });

  it.each([
    ['a wrong secret', { signWith: 'not-the-secret-at-all' }],
    ['a stale timestamp', { timestamp: new Date(Date.now() - 11 * 60 * 1000).toISOString() }],
  ])('refuses %s and publishes nothing', async (_label, options) => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    expect((await deliver(context, 'notification', followEvent(), options)).statusCode).toBe(403);
    expect(context.published).toEqual([]);
  });

  it('refuses an unsigned request', async () => {
    context = build();
    const response = await context.app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: { 'content-type': 'application/json', 'twitch-eventsub-message-type': 'notification' },
      payload: JSON.stringify(followEvent()),
    });
    expect(response.statusCode).toBe(403);
  });

  it('ignores events while Twitch is not connected, and events for another channel', async () => {
    context = build();
    expect((await deliver(context, 'notification', followEvent())).statusCode).toBe(204);
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    expect((await deliver(context, 'notification', followEvent('999'))).statusCode).toBe(204);
    expect(context.published).toEqual([]);
  });

  it('ignores the per-recipient sub of a gift but alerts the gift once', async () => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    const base = { broadcaster_user_id: broadcasterId };
    await deliver(context, 'notification', {
      subscription: { type: 'channel.subscription.gift' },
      event: { ...base, user_name: 'Bo', total: 3, tier: '1000', cumulative_total: 10, is_anonymous: false },
    });
    for (const recipient of ['A', 'B', 'C']) {
      await deliver(context, 'notification', { subscription: { type: 'channel.subscribe' }, event: { ...base, user_name: recipient, tier: '1000', is_gift: true } });
    }
    expect(context.published.map((alert) => alert.kind)).toEqual(['gift']);
  });

  it('acknowledges but does not alert a kind the streamer switched off', async () => {
    context = build({ EVENT_ALERTS: 'sub,raid' });
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    expect((await deliver(context, 'notification', followEvent())).statusCode).toBe(204);
    expect(context.published).toEqual([]);
  });

  it('acknowledges a malformed event without crashing', async () => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    const response = await deliver(context, 'notification', { subscription: { type: 'channel.cheer' }, event: { broadcaster_user_id: broadcasterId } });
    expect(response.statusCode).toBe(204);
    expect(context.published).toEqual([]);
  });

  it('records a revocation so the admin page can ask for a reconnect', async () => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    const response = await deliver(context, 'revocation', { subscription: { type: 'channel.follow', status: 'authorization_revoked' } });
    expect(response.statusCode).toBe(204);
    expect(context.store.connections.find('twitch')).toMatchObject({ status: 'revoked', statusReason: 'authorization_revoked' });
    expect((await deliver(context, 'notification', followEvent())).statusCode).toBe(204);
    expect(context.published).toEqual([]);
  });

  it('does not exist when Twitch is not configured', async () => {
    context = build({}, false);
    expect((await deliver(context, 'notification', followEvent())).statusCode).toBe(404);
  });
});

describe('Twitch admin connection', () => {
  let context: Context | undefined;
  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it('explains how to enable Twitch when it is not configured', async () => {
    context = build({}, false);
    const cookie = await signIn(context.app);
    const page = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(page.body).toContain('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET');
    expect((await context.app.inject({ method: 'GET', url: '/admin/twitch/connect', headers: { cookie } })).statusCode).toBe(404);
  });

  it('requires an admin session to start connecting', async () => {
    context = build();
    const response = await context.app.inject({ method: 'GET', url: '/admin/twitch/connect' });
    expect(response.headers.location).toBe('/admin/login');
  });

  it('connects through Twitch and back, creating the subscriptions', async () => {
    context = build();
    const cookie = await signIn(context.app);
    expect((await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body).toContain('Connect Twitch');

    const start = await context.app.inject({ method: 'GET', url: '/admin/twitch/connect', headers: { cookie } });
    expect(start.statusCode).toBe(303);
    expect(context.api.authorizeUrl).toHaveBeenCalledWith('https://dono.example.com/admin/twitch/callback', expect.any(String));
    const state = stateFrom(start);
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // The return trip arrives without the admin cookie, as it would from twitch.tv.
    const back = await context.app.inject({ method: 'GET', url: `/admin/twitch/callback?code=abc&state=${state}` });
    expect(back.headers.location).toBe('/admin?notice=twitch-connected');
    expect(context.api.identifyStreamer).toHaveBeenCalledWith('abc', 'https://dono.example.com/admin/twitch/callback');
    expect(context.api.createSubscription).toHaveBeenCalledTimes(6);
    expect(context.api.createSubscription).toHaveBeenCalledWith(expect.anything(), 'https://dono.example.com/webhooks/twitch', secret);
    expect(context.store.connections.find('twitch')).toMatchObject({ accountLogin: 'machinearash', status: 'active' });

    const page = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(page.body).toContain('Connected as <strong>machinearash</strong>');
  });

  it('accepts each state once, and refuses unknown ones', async () => {
    context = build();
    const cookie = await signIn(context.app);
    const state = stateFrom(await context.app.inject({ method: 'GET', url: '/admin/twitch/connect', headers: { cookie } }));
    await context.app.inject({ method: 'GET', url: `/admin/twitch/callback?code=abc&state=${state}` });
    const replayed = await context.app.inject({ method: 'GET', url: `/admin/twitch/callback?code=abc&state=${state}` });
    expect(replayed.headers.location).toBe('/admin?notice=twitch-expired');
    const forged = await context.app.inject({ method: 'GET', url: '/admin/twitch/callback?code=abc&state=forged' });
    expect(forged.headers.location).toBe('/admin?notice=twitch-expired');
    expect(context.api.identifyStreamer).toHaveBeenCalledOnce();
  });

  it('changes nothing when the streamer declines on Twitch', async () => {
    context = build();
    const cookie = await signIn(context.app);
    const state = stateFrom(await context.app.inject({ method: 'GET', url: '/admin/twitch/connect', headers: { cookie } }));
    const response = await context.app.inject({ method: 'GET', url: `/admin/twitch/callback?error=access_denied&state=${state}` });
    expect(response.headers.location).toBe('/admin?notice=twitch-denied');
    expect(context.store.connections.find('twitch')).toBeUndefined();
  });

  it('reports a Twitch failure instead of crashing', async () => {
    context = build();
    context.api.identifyStreamer.mockRejectedValueOnce(new Error('twitch down'));
    const cookie = await signIn(context.app);
    const state = stateFrom(await context.app.inject({ method: 'GET', url: '/admin/twitch/connect', headers: { cookie } }));
    const response = await context.app.inject({ method: 'GET', url: `/admin/twitch/callback?code=abc&state=${state}` });
    expect(response.headers.location).toBe('/admin?notice=twitch-failed');
  });

  it('shows a revoked connection with a reconnect button, and disconnects', async () => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    context.store.connections.markRevoked('twitch', 'authorization_revoked');
    const cookie = await signIn(context.app);
    const page = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(page.body).toContain('Twitch stopped sending events for machinearash (authorization_revoked)');
    expect(page.body).toContain('Reconnect Twitch');

    const response = await context.app.inject({ method: 'POST', url: '/admin/twitch/disconnect', headers: { cookie } });
    expect(response.headers.location).toBe('/admin?notice=twitch-disconnected');
    expect(context.store.connections.find('twitch')).toBeUndefined();
  });

  it('refuses to disconnect without a session', async () => {
    context = build();
    context.store.connections.connect('twitch', broadcasterId, 'machinearash');
    const response = await context.app.inject({ method: 'POST', url: '/admin/twitch/disconnect' });
    expect(response.headers.location).toBe('/admin/login');
    expect(context.store.connections.find('twitch')).toBeDefined();
  });
});
