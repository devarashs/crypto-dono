/**
 * Linking and unlinking the streamer's Twitch channel.
 *
 * Connecting is idempotent: subscriptions this server created earlier are
 * removed and recreated, so reconnecting fixes any revoked or half-made state.
 * Subscriptions belonging to other callbacks (other apps or servers using the
 * same Twitch app) are never touched.
 */
import type { ConnectionStore } from '../platforms/connection-store.ts';
import { twitchSubscriptionsFor, type TwitchApi } from './twitch-api.ts';

export type TwitchConnectionDependencies = {
  readonly api: TwitchApi;
  readonly connections: ConnectionStore;
  /** This server's EventSub webhook URL. */
  readonly callbackUrl: string;
  /** HMAC secret Twitch signs every message with. */
  readonly eventSubSecret: string;
};

export type ConnectResult = {
  readonly login: string;
  /** Subscription types Twitch refused, e.g. for a missing scope. */
  readonly failedTypes: readonly string[];
};

/**
 * @param code The authorization code from Twitch's redirect.
 * @param redirectUri Must match the one used to start the sign-in.
 */
export async function connectTwitch(
  dependencies: TwitchConnectionDependencies,
  code: string,
  redirectUri: string,
): Promise<ConnectResult> {
  const streamer = await dependencies.api.identifyStreamer(code, redirectUri);
  dependencies.connections.connect('twitch', streamer.id, streamer.login);
  await removeOwnSubscriptions(dependencies);

  const failedTypes: string[] = [];
  for (const subscription of twitchSubscriptionsFor(streamer.id)) {
    try {
      await dependencies.api.createSubscription(subscription, dependencies.callbackUrl, dependencies.eventSubSecret);
    } catch {
      // One refused type (say, bits on a channel without them) should not stop
      // the others; the caller reports which ones failed.
      failedTypes.push(subscription.type);
    }
  }
  return { login: streamer.login, failedTypes };
}

/** Removes this server's subscriptions and forgets the channel. */
export async function disconnectTwitch(dependencies: TwitchConnectionDependencies): Promise<void> {
  await removeOwnSubscriptions(dependencies);
  dependencies.connections.disconnect('twitch');
}

async function removeOwnSubscriptions(dependencies: TwitchConnectionDependencies): Promise<void> {
  const existing = await dependencies.api.listSubscriptions();
  for (const subscription of existing) {
    if (subscription.callback === dependencies.callbackUrl) await dependencies.api.deleteSubscription(subscription.id);
  }
}
