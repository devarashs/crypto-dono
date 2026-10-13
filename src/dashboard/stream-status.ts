/**
 * Live status of the streamer's Twitch and Kick channels for the dashboard's
 * status bar: live or offline, viewers, and when the stream started.
 *
 * Asked of each platform every 30 seconds, but only while a dashboard is open,
 * so a quiet server makes no calls. Uses each app's own token; nothing the
 * streamer signed in with. Encoder health (bitrate, dropped frames) is not
 * offered by either platform; OBS shows it.
 */
import type { KickApi } from '../kick/kick-api.ts';
import type { ConnectionStore } from '../platforms/connection-store.ts';
import type { LiveStatus, TwitchApi } from '../twitch/twitch-api.ts';
import type { DashboardHub } from './dashboard-hub.ts';

export const statusIntervalMs = 30_000;

export type ChannelStatus = {
  readonly platform: 'twitch' | 'kick';
  /** "unknown": the platform could not be asked just now. */
  readonly state: 'live' | 'offline' | 'not-connected' | 'unknown';
  readonly login?: string;
  readonly viewers?: number;
  /** ISO start of the current stream, for the uptime. */
  readonly startedAt?: string;
  readonly title?: string;
};

export type StreamStatusDependencies = {
  readonly connections: ConnectionStore;
  readonly hub: DashboardHub;
  readonly twitch?: { getStream: TwitchApi['getStream'] };
  readonly kick?: { getStream: KickApi['getStream'] };
  readonly onError?: (platform: string, error: unknown) => void;
};

export type StreamStatusPoller = ReturnType<typeof createStreamStatusPoller>;

export function createStreamStatusPoller(dependencies: StreamStatusDependencies) {
  const { connections, hub } = dependencies;
  let latest: ChannelStatus[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  async function statusOf(
    platform: 'twitch' | 'kick',
    source: { getStream(id: string): Promise<LiveStatus> } | undefined,
  ): Promise<ChannelStatus | null> {
    if (source === undefined) return null;
    const connection = connections.find(platform);
    if (connection === undefined || connection.status !== 'active') return { platform, state: 'not-connected' };
    try {
      const stream = await source.getStream(connection.accountId);
      return stream.live
        ? { platform, state: 'live', login: connection.accountLogin, viewers: stream.viewers, startedAt: stream.startedAt, title: stream.title }
        : { platform, state: 'offline', login: connection.accountLogin };
    } catch (error) {
      dependencies.onError?.(platform, error);
      return { platform, state: 'unknown', login: connection.accountLogin };
    }
  }

  /** Asks both platforms now and tells open dashboards. One request at a time. */
  function refresh(): Promise<void> {
    inFlight ??= (async () => {
      const results = await Promise.all([statusOf('twitch', dependencies.twitch), statusOf('kick', dependencies.kick)]);
      latest = results.filter((status): status is ChannelStatus => status !== null);
      hub.publish({ type: 'status', statuses: latest });
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    /** The last known statuses, for a dashboard that just opened. */
    current(): readonly ChannelStatus[] {
      return latest;
    },
    refresh,
    /** Polls every 30 s while anyone is watching. */
    start(): void {
      timer ??= setInterval(() => {
        if (hub.subscriberCount > 0) void refresh();
      }, statusIntervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
