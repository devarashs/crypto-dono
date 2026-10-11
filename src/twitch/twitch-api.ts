/**
 * The few Twitch API calls this service makes: the OAuth sign-in that grants
 * read access, an app access token, and EventSub subscription management.
 *
 * Docs: https://dev.twitch.tv/docs/authentication/ and
 * https://dev.twitch.tv/docs/eventsub/manage-subscriptions/
 * Webhook subscriptions must be created with an app access token; the user's
 * consent (the scopes below) is what lets the app token subscribe.
 */
import { z } from 'zod';

/** Read-only scopes: followers, subscriptions, bits. Raids need none. */
export const twitchScopes = ['moderator:read:followers', 'channel:read:subscriptions', 'bits:read'] as const;

export class TwitchApiError extends Error {
  readonly statusCode: number;
  /** Truncated response body, for logs. */
  readonly responseBody: string;
  constructor(what: string, statusCode: number, responseBody: string) {
    super(`Twitch ${what} failed with HTTP ${statusCode}`);
    this.name = 'TwitchApiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export type TwitchSubscriptionRequest = {
  readonly type: string;
  readonly version: string;
  readonly condition: Readonly<Record<string, string>>;
};

export type TwitchSubscription = {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly callback: string | null;
};

export type TwitchApiOptions = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
};

const tokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });
const userResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), login: z.string().min(1), display_name: z.string() })).min(1),
});
const subscriptionSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  transport: z.object({ callback: z.string().optional() }).loose(),
});
const subscriptionListSchema = z.object({
  data: z.array(subscriptionSchema),
  pagination: z.object({ cursor: z.string().optional() }).loose().optional(),
});

export type TwitchApi = ReturnType<typeof createTwitchApi>;

export function createTwitchApi(options: TwitchApiOptions) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let appToken: { value: string; expiresAt: number } | undefined;

  async function request(what: string, url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImplementation(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    if (!response.ok) throw new TwitchApiError(what, response.status, text.slice(0, 500));
    return text === '' ? undefined : JSON.parse(text);
  }

  /** Client-credentials token, cached until a minute before it expires. */
  async function getAppAccessToken(): Promise<string> {
    if (appToken !== undefined && appToken.expiresAt > now() + 60_000) return appToken.value;
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: 'client_credentials',
    });
    const token = tokenResponseSchema.parse(
      await request('app token', 'https://id.twitch.tv/oauth2/token', { method: 'POST', body }),
    );
    appToken = { value: token.access_token, expiresAt: now() + token.expires_in * 1000 };
    return appToken.value;
  }

  async function helix(what: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await getAppAccessToken();
    return request(what, `https://api.twitch.tv/helix${path}`, {
      ...init,
      headers: {
        'client-id': options.clientId,
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
    });
  }

  return {
    /** Where to send the streamer to approve read access. */
    authorizeUrl(redirectUri: string, state: string): string {
      const url = new URL('https://id.twitch.tv/oauth2/authorize');
      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: twitchScopes.join(' '),
        state,
        // Always show the consent screen, so reconnecting re-grants every scope.
        force_verify: 'true',
      }).toString();
      return url.toString();
    },

    /**
     * Turns the code from the redirect into the streamer's identity. The user
     * token is used once and not kept: webhooks only need the consent it proves.
     */
    async identifyStreamer(code: string, redirectUri: string): Promise<{ id: string; login: string }> {
      const body = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      const token = tokenResponseSchema.parse(
        await request('code exchange', 'https://id.twitch.tv/oauth2/token', { method: 'POST', body }),
      );
      const users = userResponseSchema.parse(
        await request('user lookup', 'https://api.twitch.tv/helix/users', {
          headers: { 'client-id': options.clientId, authorization: `Bearer ${token.access_token}` },
        }),
      );
      const user = users.data[0]!;
      return { id: user.id, login: user.login };
    },

    async createSubscription(
      subscription: TwitchSubscriptionRequest,
      callback: string,
      secret: string,
    ): Promise<TwitchSubscription> {
      const created = z.object({ data: z.array(subscriptionSchema).min(1) }).parse(
        await helix('subscription create', '/eventsub/subscriptions', {
          method: 'POST',
          body: JSON.stringify({ ...subscription, transport: { method: 'webhook', callback, secret } }),
        }),
      );
      return toSubscription(created.data[0]!);
    },

    /** Every subscription this app holds, across pages. */
    async listSubscriptions(): Promise<TwitchSubscription[]> {
      const all: TwitchSubscription[] = [];
      let cursor: string | undefined;
      // Bounded: a single streamer has a handful of subscriptions.
      for (let page = 0; page < 20; page += 1) {
        const query = cursor === undefined ? '' : `?after=${encodeURIComponent(cursor)}`;
        const list = subscriptionListSchema.parse(await helix('subscription list', `/eventsub/subscriptions${query}`));
        all.push(...list.data.map(toSubscription));
        cursor = list.pagination?.cursor;
        if (cursor === undefined) break;
      }
      return all;
    },

    async deleteSubscription(id: string): Promise<void> {
      await helix('subscription delete', `/eventsub/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

function toSubscription(raw: z.infer<typeof subscriptionSchema>): TwitchSubscription {
  return { id: raw.id, type: raw.type, status: raw.status, callback: raw.transport.callback ?? null };
}

/** The EventSub subscriptions that feed the overlay, for one broadcaster. */
export function twitchSubscriptionsFor(broadcasterId: string): TwitchSubscriptionRequest[] {
  const broadcaster = { broadcaster_user_id: broadcasterId };
  return [
    // The streamer is their own moderator, which version 2 requires.
    { type: 'channel.follow', version: '2', condition: { ...broadcaster, moderator_user_id: broadcasterId } },
    { type: 'channel.subscribe', version: '1', condition: broadcaster },
    { type: 'channel.subscription.message', version: '1', condition: broadcaster },
    { type: 'channel.subscription.gift', version: '1', condition: broadcaster },
    { type: 'channel.cheer', version: '1', condition: broadcaster },
    { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: broadcasterId } },
  ];
}
