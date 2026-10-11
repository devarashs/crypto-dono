import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/database.ts';
import { createConnectionStore, type ConnectionStore } from '../src/platforms/connection-store.ts';
import type { TwitchApi, TwitchSubscription } from '../src/twitch/twitch-api.ts';
import { connectTwitch, disconnectTwitch } from '../src/twitch/twitch-connection.ts';

const callbackUrl = 'https://dono.example.com/webhooks/twitch';

function fakeApi(existing: TwitchSubscription[], failing: readonly string[] = []) {
  const created: string[] = [];
  const deleted: string[] = [];
  const api = {
    authorizeUrl: vi.fn(),
    identifyStreamer: vi.fn(async () => ({ id: '111', login: 'machinearash' })),
    listSubscriptions: vi.fn(async () => existing),
    deleteSubscription: vi.fn(async (id: string) => {
      deleted.push(id);
    }),
    createSubscription: vi.fn(async (subscription: { type: string }) => {
      if (failing.includes(subscription.type)) throw new Error('refused');
      created.push(subscription.type);
      return { id: `new-${subscription.type}`, type: subscription.type, status: 'webhook_callback_verification_pending', callback: callbackUrl };
    }),
  } as unknown as TwitchApi;
  return { api, created, deleted };
}

describe('twitch connection', () => {
  let connections: ConnectionStore;
  beforeEach(() => {
    connections = createConnectionStore(openDatabase(':memory:'));
  });

  it('records the channel, replaces only its own old subscriptions, and creates all six', async () => {
    const twitch = fakeApi([
      { id: 'old-mine', type: 'channel.follow', status: 'authorization_revoked', callback: callbackUrl },
      { id: 'someone-else', type: 'channel.follow', status: 'enabled', callback: 'https://other.example/hook' },
    ]);
    const result = await connectTwitch({ api: twitch.api, connections, callbackUrl, eventSubSecret: 's'.repeat(32) }, 'code', 'https://redirect');

    expect(result).toEqual({ login: 'machinearash', failedTypes: [] });
    expect(connections.find('twitch')).toMatchObject({ accountId: '111', accountLogin: 'machinearash', status: 'active' });
    expect(twitch.deleted).toEqual(['old-mine']);
    expect(twitch.created).toEqual([
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.message',
      'channel.subscription.gift',
      'channel.cheer',
      'channel.raid',
    ]);
    expect(twitch.api.createSubscription).toHaveBeenCalledWith(expect.anything(), callbackUrl, 's'.repeat(32));
  });

  it('keeps going when Twitch refuses one type, and reports it', async () => {
    const twitch = fakeApi([], ['channel.cheer']);
    const result = await connectTwitch({ api: twitch.api, connections, callbackUrl, eventSubSecret: 'x'.repeat(32) }, 'code', 'r');
    expect(result.failedTypes).toEqual(['channel.cheer']);
    expect(twitch.created).toHaveLength(5);
  });

  it('removes its subscriptions and forgets the channel on disconnect', async () => {
    connections.connect('twitch', '111', 'machinearash');
    const twitch = fakeApi([
      { id: 'mine', type: 'channel.raid', status: 'enabled', callback: callbackUrl },
      { id: 'theirs', type: 'channel.raid', status: 'enabled', callback: 'https://other.example/hook' },
    ]);
    await disconnectTwitch({ api: twitch.api, connections, callbackUrl, eventSubSecret: 'x'.repeat(32) });
    expect(twitch.deleted).toEqual(['mine']);
    expect(connections.find('twitch')).toBeUndefined();
  });
});
