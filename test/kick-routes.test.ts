import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
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
};

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
  const app = buildApp(config, {
    donations: store.donations,
    leaderboard: store.leaderboard,
    connections: store.connections,
    nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
    alertHub,
    ...(withKick && { kick: { publicKey } }),
  });
  return { app, store, published, keyFetches };
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
          kick: { publicKey: failing },
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
