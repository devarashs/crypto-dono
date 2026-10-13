/**
 * Stored platform events (follows, subs, ...), for the live dashboard's feed.
 * Written once per event as it arrives, whatever the alert switches say, so the
 * feed shows everything that happened. Kept 30 days.
 */
import type { Database } from '../database.ts';
import type { StreamEvent, StreamEventKind, StreamPlatform } from './stream-event.ts';

export const eventRetentionMs = 30 * 24 * 60 * 60 * 1000;

export type StoredEvent = StreamEvent & {
  /** The alert id it was published under, e.g. "twitch-<message id>". */
  readonly alertId: string;
  readonly receivedAt: string;
};

type EventRow = {
  alert_id: string;
  platform: StreamPlatform;
  kind: StreamEventKind;
  actor_name: string;
  months: number | null;
  count: number | null;
  bits: number | null;
  kicks: number | null;
  viewers: number | null;
  message: string | null;
  received_at: string;
};

export type EventLog = ReturnType<typeof createEventLog>;

export function createEventLog(database: Database, now: () => Date = () => new Date()) {
  const insertStatement = database.prepare(`
    INSERT OR IGNORE INTO stream_events
      (alert_id, platform, kind, actor_name, months, count, bits, kicks, viewers, message, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pruneStatement = database.prepare('DELETE FROM stream_events WHERE received_at < ?');
  const recentStatement = database.prepare('SELECT * FROM stream_events ORDER BY received_at DESC, id DESC LIMIT ?');

  return {
    /**
     * Stores an event; a repeated alert id is ignored.
     * @returns The stored event, with its time.
     */
    record(event: StreamEvent, alertId: string): StoredEvent {
      const receivedAt = now();
      pruneStatement.run(new Date(receivedAt.getTime() - eventRetentionMs).toISOString());
      insertStatement.run(
        alertId,
        event.platform,
        event.kind,
        event.actorName,
        event.months ?? null,
        event.count ?? null,
        event.bits ?? null,
        event.kicks ?? null,
        event.viewers ?? null,
        event.message ?? null,
        receivedAt.toISOString(),
      );
      return { ...event, alertId, receivedAt: receivedAt.toISOString() };
    },

    /** Newest first, at most `limit` (capped at 200). */
    recent(limit: number): StoredEvent[] {
      const rows = recentStatement.all(Math.min(Math.max(Math.trunc(limit), 1), 200)) as EventRow[];
      return rows.map((row) => ({
        alertId: row.alert_id,
        platform: row.platform,
        kind: row.kind,
        actorName: row.actor_name,
        ...(row.months !== null && { months: row.months }),
        ...(row.count !== null && { count: row.count }),
        ...(row.bits !== null && { bits: row.bits }),
        ...(row.kicks !== null && { kicks: row.kicks }),
        ...(row.viewers !== null && { viewers: row.viewers }),
        ...(row.message !== null && { message: row.message }),
        receivedAt: row.received_at,
      }));
    },
  };
}
