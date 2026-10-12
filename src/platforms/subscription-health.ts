/**
 * Checks that the platforms still hold the alert subscriptions this server made,
 * so a connection that silently stopped working is noticed on the admin page
 * rather than mid-stream.
 *
 * Run at startup and once a day (server.ts). A finding is only shown, never
 * acted on: the connection stays active and the remaining subscriptions keep
 * alerting; the streamer reconnects to repair it. Results live in memory, since
 * every start checks again.
 */
import { kickEventNames, type KickApi } from '../kick/kick-api.ts';
import { twitchSubscriptionsFor, type TwitchApi } from '../twitch/twitch-api.ts';
import type { ConnectionStore } from './connection-store.ts';

export type HealthPlatform = 'twitch' | 'kick';

export type HealthFinding = {
  /** When this check ran, ISO. */
  readonly checkedAt: string;
  /** What is wrong, for the admin page; `null` when everything was in place. */
  readonly problem: string | null;
};

export type SubscriptionHealthDependencies = {
  readonly connections: ConnectionStore;
  readonly twitch?: { readonly api: TwitchApi; readonly callbackUrl: string };
  readonly kick?: { readonly api: KickApi };
  readonly now?: () => Date;
};

export type SubscriptionHealth = ReturnType<typeof createSubscriptionHealth>;

export function createSubscriptionHealth(dependencies: SubscriptionHealthDependencies) {
  const { connections, twitch, kick } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const findings = new Map<HealthPlatform, HealthFinding>();

  async function checkTwitch(api: TwitchApi, callbackUrl: string, broadcasterId: string): Promise<string | null> {
    const ours = (await api.listSubscriptions()).filter((subscription) => subscription.callback === callbackUrl);
    const problems = twitchSubscriptionsFor(broadcasterId).flatMap(({ type }) => {
      const found = ours.filter((subscription) => subscription.type === type);
      if (found.length === 0) return [`${type} missing`];
      // Pending only for the moment between creating and Twitch's challenge.
      const working = found.some((subscription) =>
        ['enabled', 'webhook_callback_verification_pending'].includes(subscription.status),
      );
      return working ? [] : [`${type} ${found[0]!.status}`];
    });
    return problems.length === 0 ? null : problems.join(', ');
  }

  async function checkKick(api: KickApi, broadcasterId: string): Promise<string | null> {
    const events = new Set((await api.listSubscriptions(broadcasterId)).map((subscription) => subscription.event));
    const missing = kickEventNames.filter((name) => !events.has(name));
    return missing.length === 0 ? null : missing.map((name) => `${name} missing`).join(', ');
  }

  return {
    /**
     * Checks every connected platform. A platform that cannot be reached keeps
     * its previous finding: an outage is not evidence the subscriptions are gone.
     *
     * @returns What was found, per platform checked, for the log.
     */
    async check(): Promise<Partial<Record<HealthPlatform, string | null>>> {
      const results: Partial<Record<HealthPlatform, string | null>> = {};
      const twitchConnection = connections.find('twitch');
      if (twitch !== undefined && twitchConnection?.status === 'active') {
        try {
          results.twitch = await checkTwitch(twitch.api, twitch.callbackUrl, twitchConnection.accountId);
          findings.set('twitch', { checkedAt: now().toISOString(), problem: results.twitch });
        } catch (error) {
          results.twitch = `could not check: ${(error as Error).message}`;
        }
      } else {
        findings.delete('twitch');
      }
      const kickConnection = connections.find('kick');
      if (kick !== undefined && kickConnection?.status === 'active') {
        try {
          results.kick = await checkKick(kick.api, kickConnection.accountId);
          findings.set('kick', { checkedAt: now().toISOString(), problem: results.kick });
        } catch (error) {
          results.kick = `could not check: ${(error as Error).message}`;
        }
      } else {
        findings.delete('kick');
      }
      return results;
    },

    /** The last finding for a platform, or `undefined` if not checked since it connected. */
    finding(platform: HealthPlatform): HealthFinding | undefined {
      return findings.get(platform);
    },

    /** Forgets a finding, e.g. after reconnecting, when it no longer applies. */
    clear(platform: HealthPlatform): void {
      findings.delete(platform);
    },
  };
}
