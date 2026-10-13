import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.ts';
import { kickEventNames, type KickApi } from '../src/kick/kick-api.ts';
import { createConnectionStore, type ConnectionStore } from '../src/platforms/connection-store.ts';
import { createSubscriptionHealth } from '../src/platforms/subscription-health.ts';
import { twitchSubscriptionsFor, type TwitchApi, type TwitchSubscription } from '../src/twitch/twitch-api.ts';

const callbackUrl = 'https://dono.example.com/webhooks/twitch';
const allTwitch = (status = 'enabled'): TwitchSubscription[] =>
  twitchSubscriptionsFor('111').map(({ type }, index) => ({ id: `t${index}`, type, status, callback: callbackUrl }));

function twitchApi(subscriptions: () => TwitchSubscription[]): TwitchApi {
  return { listSubscriptions: async () => subscriptions() } as unknown as TwitchApi;
}

function kickApi(events: () => readonly string[]): KickApi {
  return {
    listSubscriptions: async (broadcaster: string) =>
      events().map((event, index) => ({ id: `k${index}`, event, broadcasterUserId: broadcaster })),
  } as unknown as KickApi;
}

describe('subscription health', () => {
  let connections: ConnectionStore;
  const now = () => new Date('2026-10-13T12:00:00.000Z');
  beforeEach(() => {
    connections = createConnectionStore(openDatabase(':memory:'));
  });

  it('finds nothing wrong when every expected subscription is there and enabled', async () => {
    connections.connect('twitch', '111', 'machinearash');
    connections.connect('kick', '222', 'machinearash');
    const health = createSubscriptionHealth({
      connections,
      twitch: { api: twitchApi(() => allTwitch()), callbackUrl },
      kick: { api: kickApi(() => kickEventNames) },
      now,
    });
    expect(await health.check()).toEqual({ twitch: null, kick: null });
    expect(health.finding('twitch')).toEqual({ checkedAt: '2026-10-13T12:00:00.000Z', problem: null });
  });

  it('names Twitch subscriptions that are missing, failing, or belong to another server', async () => {
    connections.connect('twitch', '111', 'machinearash');
    const subscriptions = allTwitch()
      .filter((subscription) => subscription.type !== 'channel.raid')
      .map((subscription) =>
        subscription.type === 'channel.cheer'
          ? { ...subscription, status: 'notification_failures_exceeded' }
          : subscription.type === 'channel.follow'
            ? { ...subscription, callback: 'https://elsewhere.example/hook' }
            : subscription,
      );
    const health = createSubscriptionHealth({ connections, twitch: { api: twitchApi(() => subscriptions), callbackUrl }, now });
    expect(await health.check()).toEqual({
      twitch: 'channel.follow missing, channel.cheer notification_failures_exceeded, channel.raid missing',
    });
  });

  it('names Kick events that are no longer subscribed', async () => {
    connections.connect('kick', '222', 'machinearash');
    const health = createSubscriptionHealth({
      connections,
      kick: { api: kickApi(() => ['channel.followed', 'kicks.gifted']) },
      now,
    });
    expect((await health.check()).kick).toBe(
      'channel.subscription.new missing, channel.subscription.renewal missing, channel.subscription.gifts missing, chat.message.sent missing, moderation.banned missing',
    );
    expect(health.finding('kick')?.problem).toContain('channel.subscription.new missing');
  });

  it('keeps the last finding when the platform cannot be reached', async () => {
    connections.connect('kick', '222', 'machinearash');
    let reachable = true;
    const api = {
      listSubscriptions: async () => {
        if (!reachable) throw new Error('Kick subscription list failed with HTTP 503');
        return [];
      },
    } as unknown as KickApi;
    const health = createSubscriptionHealth({ connections, kick: { api }, now });
    await health.check();
    const before = health.finding('kick');
    reachable = false;
    expect((await health.check()).kick).toBe('could not check: Kick subscription list failed with HTTP 503');
    expect(health.finding('kick')).toEqual(before);
  });

  it('checks only connected, active platforms, and forgets findings when one disconnects', async () => {
    let calls = 0;
    const api = twitchApi(() => (calls++, []));
    const health = createSubscriptionHealth({ connections, twitch: { api, callbackUrl }, now });
    expect(await health.check()).toEqual({});
    connections.connect('twitch', '111', 'machinearash');
    await health.check();
    expect(health.finding('twitch')).toBeDefined();
    connections.markRevoked('twitch', 'authorization_revoked');
    await health.check();
    expect(health.finding('twitch')).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('forgets a finding when told to, as after reconnecting', async () => {
    connections.connect('kick', '222', 'machinearash');
    const health = createSubscriptionHealth({ connections, kick: { api: kickApi(() => []) }, now });
    await health.check();
    health.clear('kick');
    expect(health.finding('kick')).toBeUndefined();
  });
});
