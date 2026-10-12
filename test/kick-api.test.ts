import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.ts';
import { createKickApi, createPkcePair, kickEventNames, KickApiError, type KickApi } from '../src/kick/kick-api.ts';
import { connectKick, disconnectKick } from '../src/kick/kick-connection.ts';
import { createConnectionStore, type ConnectionStore } from '../src/platforms/connection-store.ts';

type Call = { method: string; url: string; body: string; authorization: string | null };

/** A fake Kick answering by method and path, recording every call. */
function fakeKick(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const call: Call = { method, url: url.toString(), body: init?.body === undefined ? '' : String(init.body), authorization: headers.get('authorization') };
    calls.push(call);
    const handler = routes[`${method} ${url.origin}${url.pathname}`];
    return handler === undefined ? new Response('no route', { status: 404 }) : handler(call);
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tokenRoute = (call: Call) =>
  json(
    new URLSearchParams(call.body).get('grant_type') === 'client_credentials'
      ? { access_token: 'app-token', token_type: 'Bearer', expires_in: 3600 }
      : { access_token: 'user-token', token_type: 'Bearer', expires_in: 7200, refresh_token: 'r', scope: 'user:read' },
  );

describe('createPkcePair', () => {
  it('makes an S256 challenge from a long random verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});

describe('Kick API', () => {
  it('builds the authorize URL with PKCE and the needed scopes', () => {
    const url = new URL(createKickApi({ clientId: 'cid', clientSecret: 's' }).authorizeUrl('https://d.example/cb', 'st', 'ch'));
    expect(url.origin + url.pathname).toBe('https://id.kick.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      response_type: 'code',
      redirect_uri: 'https://d.example/cb',
      state: 'st',
      scope: 'user:read events:subscribe kicks:read',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code with the verifier, then identifies the streamer with the user token', async () => {
    const kick = fakeKick({
      'POST https://id.kick.com/oauth/token': tokenRoute,
      'GET https://api.kick.com/public/v1/users': () =>
        json({ data: [{ user_id: 4242, name: 'machinearash', email: 'x', profile_picture: '' }], message: 'OK' }),
    });
    const api = createKickApi({ clientId: 'cid', clientSecret: 'secret', fetch: kick.fetch });
    expect(await api.identifyStreamer('the-code', 'https://d.example/cb', 'the-verifier')).toEqual({
      id: '4242',
      login: 'machinearash',
      userToken: 'user-token',
    });
    expect(Object.fromEntries(new URLSearchParams(kick.calls[0]!.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cid',
      client_secret: 'secret',
      redirect_uri: 'https://d.example/cb',
      code_verifier: 'the-verifier',
      code: 'the-code',
    });
    expect(kick.calls[1]!.authorization).toBe('Bearer user-token');
  });

  it('subscribes to the five events and reports any Kick refused', async () => {
    const kick = fakeKick({
      'POST https://api.kick.com/public/v1/events/subscriptions': (call) => {
        const { events } = JSON.parse(call.body) as { events: { name: string }[] };
        return json({
          data: events.map(({ name }) =>
            name === 'kicks.gifted' ? { name, version: 1, error: 'missing scope' } : { name, version: 1, subscription_id: `sub-${name}` },
          ),
          message: 'OK',
        });
      },
    });
    const api = createKickApi({ clientId: 'cid', clientSecret: 's', fetch: kick.fetch });
    const results = await api.subscribe('user-token');
    expect(JSON.parse(kick.calls[0]!.body)).toEqual({ method: 'webhook', events: kickEventNames.map((name) => ({ name, version: 1 })) });
    expect(kick.calls[0]!.authorization).toBe('Bearer user-token');
    expect(results).toEqual([
      { event: 'channel.followed' },
      { event: 'channel.subscription.new' },
      { event: 'channel.subscription.renewal' },
      { event: 'channel.subscription.gifts' },
      { event: 'kicks.gifted', error: 'missing scope' },
    ]);
  });

  it('lists and deletes subscriptions with a cached app token', async () => {
    const kick = fakeKick({
      'POST https://id.kick.com/oauth/token': tokenRoute,
      'GET https://api.kick.com/public/v1/events/subscriptions': () =>
        json({ data: [{ id: 'a', app_id: 'x', broadcaster_user_id: 4242, event: 'channel.followed', method: 'webhook', version: 1 }], message: 'OK' }),
      'DELETE https://api.kick.com/public/v1/events/subscriptions': () => new Response(null, { status: 204 }),
    });
    const api = createKickApi({ clientId: 'cid', clientSecret: 's', fetch: kick.fetch });
    expect(await api.listSubscriptions('4242')).toEqual([{ id: 'a', event: 'channel.followed', broadcasterUserId: '4242' }]);
    await api.deleteSubscriptions(['a', 'b']);
    await api.deleteSubscriptions([]);
    expect(kick.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://id.kick.com/oauth/token',
      'GET https://api.kick.com/public/v1/events/subscriptions?broadcaster_user_id=4242',
      'DELETE https://api.kick.com/public/v1/events/subscriptions?id=a&id=b',
    ]);
    expect(kick.calls[2]!.authorization).toBe('Bearer app-token');
  });

  it('reports Kick errors with the status and a trimmed body', async () => {
    const kick = fakeKick({ 'POST https://id.kick.com/oauth/token': () => new Response('bad code'.repeat(200), { status: 400 }) });
    const api = createKickApi({ clientId: 'cid', clientSecret: 's', fetch: kick.fetch });
    const error = await api.identifyStreamer('c', 'r', 'v').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KickApiError);
    expect(error).toMatchObject({ statusCode: 400, message: 'Kick code exchange failed with HTTP 400' });
    expect((error as KickApiError).responseBody.length).toBe(500);
  });
});

describe('Kick connection', () => {
  let connections: ConnectionStore;
  beforeEach(() => {
    connections = createConnectionStore(openDatabase(':memory:'));
  });

  function fakeApi(existing: { id: string; broadcasterUserId: string }[]) {
    const log: string[] = [];
    const api = {
      identifyStreamer: async () => (log.push('identify'), { id: '4242', login: 'machinearash', userToken: 'user-token' }),
      listSubscriptions: async (broadcaster: string) => (log.push(`list ${broadcaster}`), existing.map((entry) => ({ ...entry, event: 'channel.followed' }))),
      deleteSubscriptions: async (ids: readonly string[]) => void log.push(`delete ${ids.join(',')}`),
      subscribe: async (token: string) => (log.push(`subscribe ${token}`), [{ event: 'channel.followed' }, { event: 'kicks.gifted', error: 'missing scope' }]),
    } as unknown as KickApi;
    return { api, log };
  }

  it('removes earlier subscriptions before subscribing, so nothing alerts twice', async () => {
    const { api, log } = fakeApi([{ id: 'old', broadcasterUserId: '4242' }, { id: 'stranger', broadcasterUserId: '999' }]);
    const result = await connectKick({ api, connections }, 'code', 'redirect', 'verifier');
    expect(log).toEqual(['identify', 'list 4242', 'delete old', 'subscribe user-token']);
    expect(result).toEqual({ login: 'machinearash', failedEvents: [{ event: 'kicks.gifted', error: 'missing scope' }] });
    expect(connections.find('kick')).toMatchObject({ accountId: '4242', accountLogin: 'machinearash', status: 'active' });
  });

  it('removes the subscriptions and forgets the channel on disconnect', async () => {
    connections.connect('kick', '4242', 'machinearash');
    const { api, log } = fakeApi([{ id: 'mine', broadcasterUserId: '4242' }]);
    await disconnectKick({ api, connections });
    expect(log).toEqual(['list 4242', 'delete mine']);
    expect(connections.find('kick')).toBeUndefined();
  });
});
