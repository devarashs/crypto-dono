/**
 * The few Kick API calls this service makes: the OAuth 2.1 sign-in (with PKCE)
 * that identifies the streamer and lets the app subscribe to their channel's
 * events, an app access token, and event subscription management.
 *
 * Docs (checked 2026-10-13): https://docs.kick.com/getting-started/generating-tokens-oauth2-flow,
 * https://docs.kick.com/apis/users and https://docs.kick.com/events/subscribe-to-events.
 * Kick sends every event to the one webhook URL set in the app's settings, so
 * subscriptions carry no callback of their own.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { LiveStatus } from '../twitch/twitch-api.ts';

/** Who the streamer is, subscribing to their events, and their Kicks. */
export const kickScopes = ['user:read', 'events:subscribe', 'kicks:read'] as const;

/** The events that feed the overlay. */
export const kickEventNames = [
  'channel.followed',
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
  'kicks.gifted',
] as const;

export class KickApiError extends Error {
  readonly statusCode: number;
  /** Truncated response body, for logs. */
  readonly responseBody: string;
  constructor(what: string, statusCode: number, responseBody: string) {
    super(`Kick ${what} failed with HTTP ${statusCode}`);
    this.name = 'KickApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/** A PKCE pair: the verifier stays on the server, the challenge goes to Kick. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export type KickSubscription = {
  readonly id: string;
  readonly event: string;
  readonly broadcasterUserId: string;
};

export type KickSubscribeResult = {
  readonly event: string;
  /** Set when Kick refused this event. */
  readonly error?: string;
};

export type KickApiOptions = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
};

const tokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const usersResponseSchema = z.object({
  data: z.array(z.object({ user_id: z.union([z.number(), z.string()]), name: z.string().min(1) }).loose()).min(1),
});
const subscribeResponseSchema = z.object({
  data: z.array(z.object({ name: z.string(), subscription_id: z.string().nullish(), error: z.string().nullish() }).loose()),
});
const channelsSchema = z.object({
  data: z.array(
    z.object({
      stream_title: z.string().nullish(),
      stream: z.object({ is_live: z.boolean(), viewer_count: z.number().nullish(), start_time: z.string().nullish() }).loose().nullish(),
    }).loose(),
  ),
});
const subscriptionListSchema = z.object({
  data: z.array(
    z.object({ id: z.string(), event: z.string(), broadcaster_user_id: z.union([z.number(), z.string()]) }).loose(),
  ),
});

export type KickApi = ReturnType<typeof createKickApi>;

export function createKickApi(options: KickApiOptions) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let appToken: { value: string; expiresAt: number } | undefined;

  async function request(what: string, url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImplementation(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (!response.ok) throw new KickApiError(what, response.status, text.slice(0, 500));
    return text === '' ? undefined : JSON.parse(text);
  }

  /** Client-credentials token, cached until a minute before it expires. */
  async function getAppAccessToken(): Promise<string> {
    if (appToken !== undefined && appToken.expiresAt > now() + 60_000) return appToken.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId,
      client_secret: options.clientSecret,
    });
    const token = tokenResponseSchema.parse(await request('app token', 'https://id.kick.com/oauth/token', { method: 'POST', body }));
    appToken = { value: token.access_token, expiresAt: now() + token.expires_in * 1000 };
    return appToken.value;
  }

  function api(what: string, path: string, token: string, init: RequestInit = {}): Promise<unknown> {
    return request(what, `https://api.kick.com/public/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
    });
  }

  return {
    /** Where to send the streamer to approve access. */
    authorizeUrl(redirectUri: string, state: string, codeChallenge: string): string {
      const url = new URL('https://id.kick.com/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: options.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        scope: kickScopes.join(' '),
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },

    /**
     * Turns the code from the redirect into the streamer's identity and a user
     * token. The caller uses the token once, to subscribe, and never stores it.
     */
    async identifyStreamer(
      code: string,
      redirectUri: string,
      codeVerifier: string,
    ): Promise<{ id: string; login: string; userToken: string }> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        code,
      });
      const token = tokenResponseSchema.parse(
        await request('code exchange', 'https://id.kick.com/oauth/token', { method: 'POST', body }),
      );
      const user = usersResponseSchema.parse(await api('user lookup', '/users', token.access_token)).data[0]!;
      return { id: String(user.user_id), login: user.name, userToken: token.access_token };
    },

    /** Subscribes the token's channel to the overlay's events, reporting each one. */
    async subscribe(userToken: string): Promise<KickSubscribeResult[]> {
      const subscribed = subscribeResponseSchema.parse(
        await api('event subscription', '/events/subscriptions', userToken, {
          method: 'POST',
          body: JSON.stringify({ method: 'webhook', events: kickEventNames.map((name) => ({ name, version: 1 })) }),
        }),
      );
      return kickEventNames.map((event) => {
        const result = subscribed.data.find((entry) => entry.name === event);
        const error = result === undefined ? "missing from Kick's reply" : (result.error ?? '');
        return error === '' ? { event } : { event, error };
      });
    },

    /** This app's subscriptions for one channel. */
    async listSubscriptions(broadcasterUserId: string): Promise<KickSubscription[]> {
      const query = `?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}`;
      const list = subscriptionListSchema.parse(
        await api('subscription list', `/events/subscriptions${query}`, await getAppAccessToken()),
      );
      return list.data.map((entry) => ({ id: entry.id, event: entry.event, broadcasterUserId: String(entry.broadcaster_user_id) }));
    },

    /** Whether the channel is live now, with viewers and start time when it is. */
    async getStream(broadcasterUserId: string): Promise<LiveStatus> {
      const channels = channelsSchema.parse(
        await api('channel lookup', `/channels?broadcaster_user_id=${encodeURIComponent(broadcasterUserId)}`, await getAppAccessToken()),
      );
      const channel = channels.data[0];
      const stream = channel?.stream;
      if (stream === null || stream === undefined || !stream.is_live) return { live: false };
      return {
        live: true,
        viewers: stream.viewer_count ?? 0,
        startedAt: stream.start_time ?? '',
        title: channel?.stream_title ?? '',
      };
    },

    async deleteSubscriptions(ids: readonly string[]): Promise<void> {
      if (ids.length === 0) return;
      const query = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
      await api('subscription delete', `/events/subscriptions?${query}`, await getAppAccessToken(), { method: 'DELETE' });
    },
  };
}
