import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.ts';
import { createEventLog, type EventLog } from '../src/events/event-log.ts';

describe('event log', () => {
  let clock: Date;
  let log: EventLog;
  beforeEach(() => {
    clock = new Date('2026-10-13T12:00:00.000Z');
    log = createEventLog(openDatabase(':memory:'), () => clock);
  });

  it('stores events with their details and lists them newest first', () => {
    log.record({ platform: 'twitch', kind: 'follow', actorName: 'neon' }, 'twitch-1');
    clock = new Date('2026-10-13T12:01:00.000Z');
    log.record({ platform: 'kick', kind: 'kicks', actorName: 'kicker', kicks: 100, message: 'gg' }, 'kick-2');
    expect(log.recent(10)).toEqual([
      { alertId: 'kick-2', platform: 'kick', kind: 'kicks', actorName: 'kicker', kicks: 100, message: 'gg', receivedAt: '2026-10-13T12:01:00.000Z' },
      { alertId: 'twitch-1', platform: 'twitch', kind: 'follow', actorName: 'neon', receivedAt: '2026-10-13T12:00:00.000Z' },
    ]);
  });

  it('stores a redelivered event once', () => {
    log.record({ platform: 'twitch', kind: 'follow', actorName: 'neon' }, 'twitch-1');
    log.record({ platform: 'twitch', kind: 'follow', actorName: 'neon' }, 'twitch-1');
    expect(log.recent(10)).toHaveLength(1);
  });

  it('forgets events older than 30 days, and respects the limit', () => {
    log.record({ platform: 'twitch', kind: 'follow', actorName: 'old' }, 'a');
    clock = new Date('2026-11-13T12:00:00.001Z');
    log.record({ platform: 'twitch', kind: 'follow', actorName: 'new' }, 'b');
    log.record({ platform: 'twitch', kind: 'follow', actorName: 'newer' }, 'c');
    expect(log.recent(10).map((event) => event.actorName)).toEqual(['newer', 'new']);
    expect(log.recent(1)).toHaveLength(1);
  });
});
