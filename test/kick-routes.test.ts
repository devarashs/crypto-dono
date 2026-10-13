import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { KickApi } from '../src/kick/kick-api.ts';
import type { KickPublicKeySource } from '../src/kick/kick-public-key.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

const pairs = [generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('rsa', { modulusLength: 2048 })];
const pemOf = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }).toString();
const broadcasterId = '123';

type Context = {
  app: FastifyInstance;
  store: ReturnType<typeof createInMemoryStore>;
  published: OverlayAlert[];
  keyFetches: { current: number; refresh: number };
  api: { [K in keyof KickApi]: ReturnType<typeof vi.fn> };
};

const password = 'correct horse battery staple';

function fakeKickApi(): Context['api'] {
  return {
    authorizeUrl: vi.fn((redirectUri: string, state: string, challenge: string) =>
      `https://id.kick.com/oauth/authorize?state=${state}&code_challenge=${challenge}&redirect_uri=${redirectUri}`),
    identifyStreamer: vi.fn(async () => ({ id: broadcasterId, login: 'machinearash', userToken: 'user-token' })),
    subscribe: vi.fn(async () => [{ event: 'channel.followed' }]),
    listSubscriptions: vi.fn(async () => []),
    deleteSubscriptions: vi.fn(async () => {}),
    getStream: vi.fn(async () => ({ live: false })),
  };
}

/**
 * @param servedKeys What Kick's key endpoint returns: the first on startup, the
 *   second (if any) on a refresh, as after a key rotation.
 */
function build(servedKeys: readonly string[] = [pemOf(pairs[0]!.publicKey)], environment: Record<string, string> = {}, withKick = true): Context {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'https://dono.example.com',
    NOWPAYMENTS_API_KEY: 'k',
    NOWPAYMENTS_IPN_SECRET: 's',
    OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
    LOG_LEVEL: 'fatal',
    ...(withKick && { KICK_CLIENT_ID: '01JXCLIENT', KICK_CLIENT_SECRET: 'kick-secret' }),
    ADMIN_PASSWORD: password,
    ...environment,
  });
  const store = createInMemoryStore();
  const alertHub = createAlertHub();
  const published: OverlayAlert[] = [];
  alertHub.subscribe((alert) => published.push(alert));
  const keyFetches = { current: 0, refresh: 0 };
  const publicKey: KickPublicKeySource = {
    current: async () => (keyFetches.current++, servedKeys[0]!),
    refresh: async () => (keyFetches.refresh++, servedKeys[1] ?? null),
  };
  const api = fakeKickApi();
  const app = buildApp(config, {
    donations: store.donations,
    leaderboard: store.leaderboard,
    connections: store.connections,
    nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
    alertHub,
    adminSessionSecret: 'a'.repeat(64),
    ...(withKick && { kick: { api: api as unknown as KickApi, publicKey } }),
  });
  return { app, store, published, keyFetches, api };
}

/** A webhook signed exactly as Kick's docs describe. */
function deliver(
  context: Context,
  eventType: string,
  payload: Record<string, unknown>,
  options: { messageId?: string; timestamp?: string; signWith?: KeyObject } = {},
) {
  const messageId = options.messageId ?? `01JX${Math.random().toString(36).slice(2, 14).toUpperCase()}`;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const body = JSON.stringify(payload);
  const signature = sign('sha256', Buffer.from(`${messageId}.${timestamp}.${body}`), options.signWith ?? pairs[0]!.privateKey).toString('base64');
  return context.app.inject({
    method: 'POST',
    url: '/webhooks/kick',
    headers: {
      'content-type': 'application/json',
      'kick-event-message-id': messageId,
      'kick-event-subscription-id': '01JXSUBSCRIPTION',
      'kick-event-signature': signature,
      'kick-event-message-timestamp': timestamp,
      'kick-event-type': eventType,
      'kick-event-version': '1',
    },
    payload: body,
  });
}

const follow = (channel = 123) => ({
  broadcaster: { user_id: channel, username: 'machinearash', is_anonymous: false },
  follower: { user_id: 9, username: 'neon', is_anonymous: false },
});

describe('Kick webhook', () => {
  let context: Context | undefined;
  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it('publishes a follow for the connected channel, once, however often it is delivered', async () => {
    context = build();
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    const first = await deliver(context, 'channel.followed', follow(), { messageId: '01JXSAME' });
    const again = await deliver(context, 'channel.followed', follow(), { messageId: '01JXSAME' });
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
    expect(context.published).toEqual([
      expect.objectContaining({ id: 'kick-01JXSAME', kind: 'follow', donorName: 'neon', badge: expect.objectContaining({ label: 'Kick' }) }),
    ]);
  });

  it('publishes Kicks with their wording and message', async () => {
    context = build();
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    await deliver(context, 'kicks.gifted', {
      broadcaster: { user_id: 123, username: 'machinearash' },
      sender: { user_id: 9, username: 'kicker' },
      gift: { amount: 100, name: 'Full Send', type: 'BASIC', tier: 'BASIC', message: 'w stream', pinned_time_seconds: 0 },
      created_at: '2026-10-13T10:00:00Z',
    });
    expect(context.published).toEqual([
      expect.objectContaining({
        kind: 'kicks',
        message: 'w stream',
        headline: [
          { text: 'kicker sent ', emphasis: false },
          { text: '100', emphasis: true },
          { text: ' Kicks', emphasis: false },
        ],
      }),
    ]);
  });

  it('accepts a message signed with a rotated key after fetching it again', async () => {
    context = build([pemOf(pairs[0]!.publicKey), pemOf(pairs[1]!.publicKey)]);
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    const response = await deliver(context, 'channel.followed', follow(), { signWith: pairs[1]!.privateKey });
    expect(response.statusCode).toBe(200);
    expect(context.keyFetches.refresh).toBe(1);
    expect(context.published).toHaveLength(1);
  });

  it.each([
    ['a wrong key', { signWith: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }],
    ['a stale timestamp', { timestamp: new Date(Date.now() - 11 * 60 * 1000).toISOString() }],
  ])('refuses %s and publishes nothing', async (_label, options) => {
    context = build();
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    expect((await deliver(context, 'channel.followed', follow(), options)).statusCode).toBe(403);
    expect(context.published).toEqual([]);
  });

  it('refuses an unsigned request', async () => {
    context = build();
    const response = await context.app.inject({
      method: 'POST',
      url: '/webhooks/kick',
      headers: { 'content-type': 'application/json', 'kick-event-type': 'channel.followed' },
      payload: JSON.stringify(follow()),
    });
    expect(response.statusCode).toBe(403);
  });

  it("asks Kick to retry when Kick's key cannot be fetched", async () => {
    context = build();
    const failing: KickPublicKeySource = { current: async () => { throw new Error('down'); }, refresh: async () => null };
    await context.app.close();
    const store = createInMemoryStore();
    context = {
      ...context,
      store,
      app: buildApp(
        loadConfig({
          PUBLIC_BASE_URL: 'https://dono.example.com',
          NOWPAYMENTS_API_KEY: 'k',
          NOWPAYMENTS_IPN_SECRET: 's',
          OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
          LOG_LEVEL: 'fatal',
          KICK_CLIENT_ID: '01JXCLIENT',
          KICK_CLIENT_SECRET: 'kick-secret',
        }),
        {
          donations: store.donations,
          leaderboard: store.leaderboard,
          connections: store.connections,
          nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
          alertHub: createAlertHub(),
          kick: { api: fakeKickApi() as unknown as KickApi, publicKey: failing },
        },
      ),
    };
    expect((await deliver(context, 'channel.followed', follow())).statusCode).toBe(503);
  });

  it('ignores events while Kick is not connected, for another channel, or switched off', async () => {
    context = build([pemOf(pairs[0]!.publicKey)], { EVENT_ALERTS: 'sub' });
    expect((await deliver(context, 'channel.followed', follow())).statusCode).toBe(200);
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    expect((await deliver(context, 'channel.followed', follow(999))).statusCode).toBe(200);
    expect((await deliver(context, 'channel.followed', follow())).statusCode).toBe(200);
    expect(context.published).toEqual([]);
  });

  it('acknowledges a malformed or unknown event without crashing', async () => {
    context = build();
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    expect((await deliver(context, 'kicks.gifted', { broadcaster: { user_id: 123 } })).statusCode).toBe(200);
    expect((await deliver(context, 'chat.message.sent', { content: 'hi' })).statusCode).toBe(200);
    expect(context.published).toEqual([]);
  });

  it('does not exist when Kick is not configured', async () => {
    context = build(undefined, {}, false);
    expect((await deliver(context, 'channel.followed', follow())).statusCode).toBe(404);
  });
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

const queryFrom = (response: LightMyRequestResponse) => new URL(response.headers.location as string).searchParams;

describe('Kick admin connection', () => {
  let context: Context | undefined;
  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it('explains how to enable Kick when it is not configured', async () => {
    context = build(undefined, {}, false);
    const cookie = await signIn(context.app);
    const page = await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(page.body).toContain('Set KICK_CLIENT_ID and KICK_CLIENT_SECRET in .env to show follows, subs and Kicks.');
    expect((await context.app.inject({ method: 'GET', url: '/admin/kick/connect', headers: { cookie } })).statusCode).toBe(404);
  });

  it('requires an admin session to start connecting', async () => {
    context = build();
    expect((await context.app.inject({ method: 'GET', url: '/admin/kick/connect' })).headers.location).toBe('/admin/login');
  });

  it('connects with PKCE: the verifier for this state goes back to Kick, and only once', async () => {
    context = build();
    const cookie = await signIn(context.app);
    expect((await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body).toContain('Connect Kick');

    const start = await context.app.inject({ method: 'GET', url: '/admin/kick/connect', headers: { cookie } });
    expect(start.statusCode).toBe(303);
    const state = queryFrom(start).get('state')!;
    const challenge = queryFrom(start).get('code_challenge')!;
    expect(context.api.authorizeUrl).toHaveBeenCalledWith('https://dono.example.com/admin/kick/callback', state, challenge);

    // Back from kick.com, without the admin cookie.
    const back = await context.app.inject({ method: 'GET', url: `/admin/kick/callback?code=abc&state=${state}` });
    expect(back.headers.location).toBe('/admin?notice=kick-connected');
    const verifier = context.api.identifyStreamer.mock.calls[0]![2] as string;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
    expect(context.store.connections.find('kick')).toMatchObject({ accountLogin: 'machinearash', status: 'active' });
    expect((await context.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body).toContain(
      'Connected as <strong>machinearash</strong>',
    );

    const replayed = await context.app.inject({ method: 'GET', url: `/admin/kick/callback?code=abc&state=${state}` });
    expect(replayed.headers.location).toBe('/admin?notice=kick-expired');
    expect(context.api.identifyStreamer).toHaveBeenCalledOnce();
  });

  it('says which events Kick refused', async () => {
    context = build();
    context.api.subscribe.mockResolvedValueOnce([{ event: 'channel.followed' }, { event: 'kicks.gifted', error: 'missing scope' }]);
    const cookie = await signIn(context.app);
    const state = queryFrom(await context.app.inject({ method: 'GET', url: '/admin/kick/connect', headers: { cookie } })).get('state');
    const back = await context.app.inject({ method: 'GET', url: `/admin/kick/callback?code=abc&state=${state}` });
    expect(back.headers.location).toBe('/admin?notice=kick-partial');
  });

  it('changes nothing when the streamer declines, and reports Kick failures', async () => {
    context = build();
    const cookie = await signIn(context.app);
    const declined = queryFrom(await context.app.inject({ method: 'GET', url: '/admin/kick/connect', headers: { cookie } })).get('state');
    expect((await context.app.inject({ method: 'GET', url: `/admin/kick/callback?error=access_denied&state=${declined}` })).headers.location).toBe(
      '/admin?notice=kick-denied',
    );
    context.api.identifyStreamer.mockRejectedValueOnce(new Error('kick down'));
    const failed = queryFrom(await context.app.inject({ method: 'GET', url: '/admin/kick/connect', headers: { cookie } })).get('state');
    expect((await context.app.inject({ method: 'GET', url: `/admin/kick/callback?code=abc&state=${failed}` })).headers.location).toBe(
      '/admin?notice=kick-failed',
    );
    expect(context.store.connections.find('kick')).toBeUndefined();
  });

  it('disconnects only with a session', async () => {
    context = build();
    context.store.connections.connect('kick', broadcasterId, 'machinearash');
    expect((await context.app.inject({ method: 'POST', url: '/admin/kick/disconnect' })).headers.location).toBe('/admin/login');
    expect(context.store.connections.find('kick')).toBeDefined();
    const cookie = await signIn(context.app);
    const response = await context.app.inject({ method: 'POST', url: '/admin/kick/disconnect', headers: { cookie } });
    expect(response.headers.location).toBe('/admin?notice=kick-disconnected');
    expect(context.store.connections.find('kick')).toBeUndefined();
  });
});
