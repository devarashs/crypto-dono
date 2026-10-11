import { describe, expect, it, vi } from 'vitest';
import { createTwitchApi, TwitchApiError, twitchScopes, twitchSubscriptionsFor } from '../src/twitch/twitch-api.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fake Twitch answering by URL, recording every request. */
function fakeTwitch(routes: Record<string, (call: Call) => { status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined ? '' : String(init.body),
    };
    calls.push(call);
    const key = Object.keys(routes).find((prefix) => `${call.method} ${url}`.startsWith(prefix));
    if (key === undefined) return new Response('no route', { status: 599 });
    const { status = 200, body } = routes[key]!(call);
    // A 204 must have no body at all, not an empty one.
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return { fetch: fetchMock, calls };
}

const appToken = () => ({ body: { access_token: 'app-token', expires_in: 3600 } });

describe('twitch api', () => {
  it('builds the authorize URL with the read-only scopes and state', () => {
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'secret', fetch: vi.fn() });
    const url = new URL(api.authorizeUrl('https://dono.example.com/admin/twitch/callback', 'state-123'));
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid',
      redirect_uri: 'https://dono.example.com/admin/twitch/callback',
      response_type: 'code',
      scope: 'moderator:read:followers channel:read:subscriptions bits:read',
      state: 'state-123',
      force_verify: 'true',
    });
    expect(twitchScopes).not.toContain('chat:edit');
  });

  it('exchanges the code and identifies the streamer with the user token', async () => {
    const twitch = fakeTwitch({
      'POST https://id.twitch.tv/oauth2/token': () => ({ body: { access_token: 'user-token', expires_in: 14000 } }),
      'GET https://api.twitch.tv/helix/users': () => ({ body: { data: [{ id: '111', login: 'machinearash', display_name: 'machinearash' }] } }),
    });
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'secret', fetch: twitch.fetch });

    expect(await api.identifyStreamer('the-code', 'https://dono.example.com/admin/twitch/callback')).toEqual({
      id: '111',
      login: 'machinearash',
    });
    expect(Object.fromEntries(new URLSearchParams(twitch.calls[0]!.body))).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      code: 'the-code',
      grant_type: 'authorization_code',
      redirect_uri: 'https://dono.example.com/admin/twitch/callback',
    });
    expect(twitch.calls[1]!.headers).toMatchObject({ 'client-id': 'cid', authorization: 'Bearer user-token' });
  });

  it('creates a webhook subscription with the app token, fetching it once', async () => {
    const twitch = fakeTwitch({
      'POST https://id.twitch.tv/oauth2/token': appToken,
      'POST https://api.twitch.tv/helix/eventsub/subscriptions': () => ({
        status: 202,
        body: { data: [{ id: 'sub-1', type: 'channel.follow', status: 'webhook_callback_verification_pending', transport: { method: 'webhook', callback: 'https://cb' } }] },
      }),
    });
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'secret', fetch: twitch.fetch });
    const [follow, raid] = [twitchSubscriptionsFor('111')[0]!, twitchSubscriptionsFor('111')[5]!];

    expect(await api.createSubscription(follow, 'https://cb', 'shh-secret-123')).toEqual({
      id: 'sub-1',
      type: 'channel.follow',
      status: 'webhook_callback_verification_pending',
      callback: 'https://cb',
    });
    await api.createSubscription(raid, 'https://cb', 'shh-secret-123');

    const tokenCalls = twitch.calls.filter((call) => call.url.includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(tokenCalls[0]!.body))).toMatchObject({ grant_type: 'client_credentials' });
    const create = twitch.calls.find((call) => call.url.endsWith('/eventsub/subscriptions'))!;
    expect(create.headers).toMatchObject({ authorization: 'Bearer app-token', 'client-id': 'cid', 'content-type': 'application/json' });
    expect(JSON.parse(create.body)).toEqual({
      type: 'channel.follow',
      version: '2',
      condition: { broadcaster_user_id: '111', moderator_user_id: '111' },
      transport: { method: 'webhook', callback: 'https://cb', secret: 'shh-secret-123' },
    });
  });

  it('refreshes the app token when it is about to expire', async () => {
    let clock = 0;
    const twitch = fakeTwitch({
      'POST https://id.twitch.tv/oauth2/token': () => ({ body: { access_token: 'app-token', expires_in: 120 } }),
      'GET https://api.twitch.tv/helix/eventsub/subscriptions': () => ({ body: { data: [] } }),
    });
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'secret', fetch: twitch.fetch, now: () => clock });
    await api.listSubscriptions();
    clock = 30_000;
    await api.listSubscriptions();
    clock = 70_000; // within a minute of expiry
    await api.listSubscriptions();
    expect(twitch.calls.filter((call) => call.url.includes('oauth2/token'))).toHaveLength(2);
  });

  it('lists subscriptions across pages', async () => {
    let page = 0;
    const twitch = fakeTwitch({
      'POST https://id.twitch.tv/oauth2/token': appToken,
      'GET https://api.twitch.tv/helix/eventsub/subscriptions': () => {
        page += 1;
        return page === 1
          ? { body: { data: [{ id: 'a', type: 'channel.follow', status: 'enabled', transport: { method: 'webhook', callback: 'https://cb' } }], pagination: { cursor: 'next' } } }
          : { body: { data: [{ id: 'b', type: 'channel.raid', status: 'enabled', transport: { method: 'webhook' } }], pagination: {} } };
      },
    });
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'secret', fetch: twitch.fetch });
    expect((await api.listSubscriptions()).map((subscription) => subscription.id)).toEqual(['a', 'b']);
    expect(twitch.calls.at(-1)!.url).toContain('?after=next');
  });

  it('deletes by id', async () => {
    const twitch = fakeTwitch({
      'POST https://id.twitch.tv/oauth2/token': appToken,
      'DELETE https://api.twitch.tv/helix/eventsub/subscriptions?id=sub%201': () => ({ status: 204 }),
    });
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'secret', fetch: twitch.fetch });
    await expect(api.deleteSubscription('sub 1')).resolves.toBeUndefined();
  });

  it('raises TwitchApiError with status and truncated body', async () => {
    const twitch = fakeTwitch({ 'POST https://id.twitch.tv/oauth2/token': () => ({ status: 400, body: { message: 'x'.repeat(900) } }) });
    const api = createTwitchApi({ clientId: 'cid', clientSecret: 'bad', fetch: twitch.fetch });
    const error = await api.listSubscriptions().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TwitchApiError);
    expect((error as TwitchApiError).statusCode).toBe(400);
    expect((error as TwitchApiError).responseBody.length).toBeLessThanOrEqual(500);
  });

  it('subscribes to the six event types for the streamer', () => {
    expect(twitchSubscriptionsFor('111').map((subscription) => `${subscription.type} v${subscription.version}`)).toEqual([
      'channel.follow v2',
      'channel.subscribe v1',
      'channel.subscription.message v1',
      'channel.subscription.gift v1',
      'channel.cheer v1',
      'channel.raid v1',
    ]);
  });
});
