import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardHub } from '../src/dashboard/dashboard-hub.ts';
import { createStreamStatusPoller } from '../src/dashboard/stream-status.ts';
import { openDatabase } from '../src/database.ts';
import { createKickApi } from '../src/kick/kick-api.ts';
import { createConnectionStore, type ConnectionStore } from '../src/platforms/connection-store.ts';
import { createTwitchApi, type LiveStatus } from '../src/twitch/twitch-api.ts';

const json = (value: unknown) => new Response(JSON.stringify(value));

describe('live status lookups', () => {
  it('reads a live Twitch stream, and an offline one', async () => {
    let live = true;
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://id.twitch.tv/oauth2/token')) return json({ access_token: 'app', expires_in: 3600 });
      expect(url).toBe('https://api.twitch.tv/helix/streams?user_id=111');
      return json({ data: live ? [{ type: 'live', viewer_count: 42, started_at: '2026-10-13T10:00:00Z', title: 'chill' }] : [] });
    }) as typeof globalThis.fetch;
    const api = createTwitchApi({ clientId: 'c', clientSecret: 's', fetch });
    expect(await api.getStream('111')).toEqual({ live: true, viewers: 42, startedAt: '2026-10-13T10:00:00Z', title: 'chill' });
    live = false;
    expect(await api.getStream('111')).toEqual({ live: false });
  });

  it('reads a live Kick channel, and an offline one', async () => {
    let stream: unknown = { is_live: true, viewer_count: 7, start_time: '2026-10-13T10:00:00Z', is_mature: false };
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://id.kick.com/oauth/token')) return json({ access_token: 'app', expires_in: 3600 });
      expect(url).toBe('https://api.kick.com/public/v1/channels?broadcaster_user_id=222');
      return json({ data: [{ broadcaster_user_id: 222, slug: 'machinearash', stream_title: 'kick title', stream }], message: 'OK' });
    }) as typeof globalThis.fetch;
    const api = createKickApi({ clientId: 'c', clientSecret: 's', fetch });
    expect(await api.getStream('222')).toEqual({ live: true, viewers: 7, startedAt: '2026-10-13T10:00:00Z', title: 'kick title' });
    stream = { is_live: false, viewer_count: 0, start_time: '0001-01-01T00:00:00Z' };
    expect(await api.getStream('222')).toEqual({ live: false });
  });
});

describe('stream status poller', () => {
  let connections: ConnectionStore;
  beforeEach(() => {
    connections = createConnectionStore(openDatabase(':memory:'));
  });

  it('reports each configured platform, and tells open dashboards', async () => {
    connections.connect('twitch', '111', 'machinearash');
    const hub = createDashboardHub();
    const received = vi.fn();
    hub.subscribe(received);
    const poller = createStreamStatusPoller({
      connections,
      hub,
      twitch: { getStream: async (): Promise<LiveStatus> => ({ live: true, viewers: 42, startedAt: 't0', title: 'chill' }) },
      kick: { getStream: async (): Promise<LiveStatus> => ({ live: false }) },
    });
    await poller.refresh();
    const expected = [
      { platform: 'twitch', state: 'live', login: 'machinearash', viewers: 42, startedAt: 't0', title: 'chill' },
      { platform: 'kick', state: 'not-connected' },
    ];
    expect(poller.current()).toEqual(expected);
    expect(received).toHaveBeenCalledWith({ type: 'status', statuses: expected });
  });

  it('says unavailable when a platform cannot be asked, and leaves out one that is not set up', async () => {
    connections.connect('kick', '222', 'machinearash');
    const onError = vi.fn();
    const poller = createStreamStatusPoller({
      connections,
      hub: createDashboardHub(),
      kick: { getStream: async () => Promise.reject(new Error('Kick down')) },
      onError,
    });
    await poller.refresh();
    expect(poller.current()).toEqual([{ platform: 'kick', state: 'unknown', login: 'machinearash' }]);
    expect(onError).toHaveBeenCalledWith('kick', expect.any(Error));
  });

  it('asks once for overlapping refreshes', async () => {
    connections.connect('twitch', '111', 'machinearash');
    const getStream = vi.fn(async (): Promise<LiveStatus> => ({ live: false }));
    const poller = createStreamStatusPoller({ connections, hub: createDashboardHub(), twitch: { getStream } });
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(getStream).toHaveBeenCalledOnce();
  });

  it('reports a channel going live only after it was seen offline', async () => {
    connections.connect('twitch', '111', 'machinearash');
    let live = true;
    const wentLive = vi.fn();
    const poller = createStreamStatusPoller({
      connections,
      hub: createDashboardHub(),
      twitch: { getStream: async (): Promise<LiveStatus> => (live ? { live: true, viewers: 1, startedAt: 't', title: '' } : { live: false }) },
      onWentLive: wentLive,
    });
    // First look after a restart, already live: not a start.
    await poller.refresh();
    expect(wentLive).not.toHaveBeenCalled();
    live = false;
    await poller.refresh();
    live = true;
    await poller.refresh();
    expect(wentLive).toHaveBeenCalledExactlyOnceWith('twitch');
    // Still live: no second start.
    await poller.refresh();
    expect(wentLive).toHaveBeenCalledOnce();
  });

  it('polls on its interval only while someone is watching', async () => {
    vi.useFakeTimers();
    try {
      connections.connect('twitch', '111', 'machinearash');
      const hub = createDashboardHub();
      const getStream = vi.fn(async (): Promise<LiveStatus> => ({ live: false }));
      const poller = createStreamStatusPoller({ connections, hub, twitch: { getStream } });
      poller.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getStream).not.toHaveBeenCalled();
      const unsubscribe = hub.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getStream).toHaveBeenCalledOnce();
      unsubscribe();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getStream).toHaveBeenCalledOnce();
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
