import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.ts';
import { createConnectionStore, type ConnectionStore } from '../src/platforms/connection-store.ts';

describe('connection store', () => {
  let store: ConnectionStore;
  let clock: Date;

  beforeEach(() => {
    clock = new Date('2026-10-11T12:00:00.000Z');
    store = createConnectionStore(openDatabase(':memory:'), () => clock);
  });

  it('is empty until a platform is connected', () => {
    expect(store.find('twitch')).toBeUndefined();
  });

  it('records a connection and replaces it on reconnect', () => {
    store.connect('twitch', '111', 'machinearash');
    expect(store.find('twitch')).toEqual({
      platform: 'twitch',
      accountId: '111',
      accountLogin: 'machinearash',
      status: 'active',
      statusReason: null,
      connectedAt: '2026-10-11T12:00:00.000Z',
    });
    clock = new Date('2026-10-12T12:00:00.000Z');
    store.connect('twitch', '222', 'other');
    expect(store.find('twitch')).toMatchObject({ accountId: '222', accountLogin: 'other', connectedAt: '2026-10-12T12:00:00.000Z' });
  });

  it('marks a revocation with its reason, and a reconnect clears it', () => {
    store.connect('twitch', '111', 'machinearash');
    store.markRevoked('twitch', 'authorization_revoked');
    expect(store.find('twitch')).toMatchObject({ status: 'revoked', statusReason: 'authorization_revoked', accountLogin: 'machinearash' });
    store.connect('twitch', '111', 'machinearash');
    expect(store.find('twitch')).toMatchObject({ status: 'active', statusReason: null });
  });

  it('forgets a disconnected platform', () => {
    store.connect('twitch', '111', 'machinearash');
    store.disconnect('twitch');
    expect(store.find('twitch')).toBeUndefined();
  });

  describe('rememberTwitchMessage', () => {
    it('is true the first time and false for a duplicate', () => {
      expect(store.rememberTwitchMessage('m1')).toBe(true);
      expect(store.rememberTwitchMessage('m1')).toBe(false);
      expect(store.rememberTwitchMessage('m2')).toBe(true);
    });

    it('forgets ids older than a day', () => {
      store.rememberTwitchMessage('m1');
      clock = new Date('2026-10-12T12:00:01.000Z');
      expect(store.rememberTwitchMessage('m1')).toBe(true);
    });
  });
});
