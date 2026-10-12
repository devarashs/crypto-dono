/**
 * Linking and unlinking the streamer's Kick channel.
 *
 * Connecting is idempotent: this app's earlier subscriptions for the channel
 * are removed before new ones are made. Kick sends every subscription to the
 * same webhook URL, so a leftover duplicate would alert every event twice.
 */
import type { ConnectionStore } from '../platforms/connection-store.ts';
import type { KickApi } from './kick-api.ts';

export type KickConnectionDependencies = {
  readonly api: KickApi;
  readonly connections: ConnectionStore;
};

export type KickConnectResult = {
  readonly login: string;
  /** Events Kick refused, with its reason, e.g. for a missing scope. */
  readonly failedEvents: readonly { readonly event: string; readonly error: string }[];
};

/**
 * @param code The authorization code from Kick's redirect.
 * @param redirectUri Must match the one used to start the sign-in.
 * @param codeVerifier The PKCE verifier created when the sign-in started.
 */
export async function connectKick(
  dependencies: KickConnectionDependencies,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<KickConnectResult> {
  const streamer = await dependencies.api.identifyStreamer(code, redirectUri, codeVerifier);
  await removeSubscriptions(dependencies, streamer.id);
  const results = await dependencies.api.subscribe(streamer.userToken);
  dependencies.connections.connect('kick', streamer.id, streamer.login);
  const failedEvents = results.flatMap((result) => (result.error === undefined ? [] : [{ event: result.event, error: result.error }]));
  return { login: streamer.login, failedEvents };
}

/** Removes this app's subscriptions for the connected channel and forgets it. */
export async function disconnectKick(dependencies: KickConnectionDependencies): Promise<void> {
  const connection = dependencies.connections.find('kick');
  if (connection !== undefined) await removeSubscriptions(dependencies, connection.accountId);
  dependencies.connections.disconnect('kick');
}

async function removeSubscriptions(dependencies: KickConnectionDependencies, broadcasterId: string): Promise<void> {
  const existing = await dependencies.api.listSubscriptions(broadcasterId);
  // The list is filtered by channel, but check anyway: never delete another channel's.
  await dependencies.api.deleteSubscriptions(
    existing.filter((subscription) => subscription.broadcasterUserId === broadcasterId).map((subscription) => subscription.id),
  );
}
