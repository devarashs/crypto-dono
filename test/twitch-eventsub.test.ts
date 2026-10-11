import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isFreshMessage, translateEventSub, verifyEventSubSignature } from '../src/twitch/eventsub.ts';

const secret = 'eventsub-test-secret-0123456789';
const broadcasterId = '111';

/** Signs exactly as Twitch documents: HMAC-SHA256(id + timestamp + body), "sha256=" prefix. */
function sign(messageId: string, timestamp: string, body: string, key = secret): string {
  return `sha256=${createHmac('sha256', key).update(messageId + timestamp + body).digest('hex')}`;
}

describe('verifyEventSubSignature', () => {
  const body = '{"subscription":{},"event":{"user_name":"Ann"}}';
  const headers = { messageId: 'm-1', timestamp: '2026-10-11T12:00:00.123Z' };

  it('accepts a signature made as Twitch documents it', () => {
    expect(verifyEventSubSignature({ ...headers, signature: sign('m-1', headers.timestamp, body) }, body, secret)).toBe(true);
  });

  it.each([
    ['a different secret', sign('m-1', headers.timestamp, body, 'another-secret-entirely')],
    ['a different message id', sign('m-2', headers.timestamp, body)],
    ['a different timestamp', sign('m-1', '2026-10-11T12:00:01.000Z', body)],
    ['a changed body', sign('m-1', headers.timestamp, body.replace('Ann', 'Bob'))],
    ['no prefix', sign('m-1', headers.timestamp, body).slice('sha256='.length)],
    ['garbage', 'sha256=zz'],
  ])('rejects a signature from %s', (_label, signature) => {
    expect(verifyEventSubSignature({ ...headers, signature }, body, secret)).toBe(false);
  });

  it('rejects missing headers', () => {
    const signature = sign('m-1', headers.timestamp, body);
    expect(verifyEventSubSignature({ messageId: undefined, timestamp: headers.timestamp, signature }, body, secret)).toBe(false);
    expect(verifyEventSubSignature({ messageId: 'm-1', timestamp: undefined, signature }, body, secret)).toBe(false);
    expect(verifyEventSubSignature({ ...headers, signature: undefined }, body, secret)).toBe(false);
  });
});

describe('isFreshMessage', () => {
  const now = Date.parse('2026-10-11T12:00:00.000Z');
  it.each([
    ['just now', '2026-10-11T12:00:00.000Z', true],
    ['9 minutes ago', '2026-10-11T11:51:00.000Z', true],
    ['11 minutes ago', '2026-10-11T11:49:00.000Z', false],
    ['30 seconds ahead (clock skew)', '2026-10-11T12:00:30.000Z', true],
    ['5 minutes ahead', '2026-10-11T12:05:00.000Z', false],
    ['not a date', 'yesterday', false],
  ])('%s → %s', (_label, timestamp, fresh) => {
    expect(isFreshMessage(timestamp, now)).toBe(fresh);
  });
});

describe('translateEventSub', () => {
  const base = { broadcaster_user_id: broadcasterId, broadcaster_user_login: 'machinearash', broadcaster_user_name: 'machinearash' };

  it('translates a follow', () => {
    expect(translateEventSub('channel.follow', { ...base, user_id: '9', user_login: 'neon', user_name: 'Neon', followed_at: 'x' }, broadcasterId)).toEqual({
      outcome: 'event',
      event: { platform: 'twitch', kind: 'follow', actorName: 'Neon' },
    });
  });

  it('translates a new sub and ignores the per-recipient sub of a gift', () => {
    expect(translateEventSub('channel.subscribe', { ...base, user_name: 'Ann', tier: '1000', is_gift: false }, broadcasterId)).toMatchObject({
      event: { kind: 'sub', actorName: 'Ann' },
    });
    expect(translateEventSub('channel.subscribe', { ...base, user_name: 'Lucky', tier: '1000', is_gift: true }, broadcasterId)).toEqual({
      outcome: 'ignored',
      reason: 'gift recipient (announced by the gift event)',
    });
  });

  it('translates a resub with months and its message, dropping an empty message', () => {
    expect(
      translateEventSub(
        'channel.subscription.message',
        { ...base, user_name: 'Ann', tier: '1000', cumulative_months: 14, streak_months: null, duration_months: 1, message: { text: ' love it ', emotes: [] } },
        broadcasterId,
      ),
    ).toEqual({ outcome: 'event', event: { platform: 'twitch', kind: 'resub', actorName: 'Ann', months: 14, message: 'love it' } });
    expect(
      translateEventSub('channel.subscription.message', { ...base, user_name: 'Ann', cumulative_months: 3, message: { text: '' } }, broadcasterId),
    ).toEqual({ outcome: 'event', event: { platform: 'twitch', kind: 'resub', actorName: 'Ann', months: 3 } });
  });

  it('translates a gift, naming anonymous gifters Anonymous', () => {
    expect(
      translateEventSub('channel.subscription.gift', { ...base, user_name: 'Bo', total: 5, tier: '1000', cumulative_total: 20, is_anonymous: false }, broadcasterId),
    ).toMatchObject({ event: { kind: 'gift', actorName: 'Bo', count: 5 } });
    expect(
      translateEventSub('channel.subscription.gift', { ...base, user_name: null, total: 1, tier: '1000', cumulative_total: null, is_anonymous: true }, broadcasterId),
    ).toMatchObject({ event: { kind: 'gift', actorName: 'Anonymous', count: 1 } });
  });

  it('translates a cheer, anonymous or not', () => {
    expect(
      translateEventSub('channel.cheer', { ...base, user_name: 'Cy', bits: 1000, message: 'Cheer1000 gg', is_anonymous: false }, broadcasterId),
    ).toEqual({ outcome: 'event', event: { platform: 'twitch', kind: 'cheer', actorName: 'Cy', bits: 1000, message: 'Cheer1000 gg' } });
    expect(translateEventSub('channel.cheer', { ...base, user_name: null, bits: 100, message: '', is_anonymous: true }, broadcasterId)).toMatchObject({
      event: { actorName: 'Anonymous', bits: 100 },
    });
  });

  it('translates a raid into this channel', () => {
    expect(
      translateEventSub(
        'channel.raid',
        { from_broadcaster_user_id: '5', from_broadcaster_user_login: 'big', from_broadcaster_user_name: 'BigStreamer', to_broadcaster_user_id: broadcasterId, to_broadcaster_user_login: 'machinearash', to_broadcaster_user_name: 'machinearash', viewers: 1234 },
        broadcasterId,
      ),
    ).toEqual({ outcome: 'event', event: { platform: 'twitch', kind: 'raid', actorName: 'BigStreamer', viewers: 1234 } });
  });

  it('ignores events for another channel', () => {
    expect(translateEventSub('channel.follow', { ...base, broadcaster_user_id: '999', user_name: 'Neon' }, broadcasterId)).toEqual({
      outcome: 'ignored',
      reason: 'event for another channel',
    });
    expect(
      translateEventSub('channel.raid', { from_broadcaster_user_name: 'X', to_broadcaster_user_id: '999', viewers: 1 }, broadcasterId),
    ).toMatchObject({ outcome: 'ignored' });
  });

  it('ignores types it does not handle', () => {
    expect(translateEventSub('stream.online', {}, broadcasterId)).toEqual({
      outcome: 'ignored',
      reason: 'unhandled subscription type stream.online',
    });
  });

  it('throws on a known type missing documented fields', () => {
    expect(() => translateEventSub('channel.cheer', { ...base, user_name: 'Cy' }, broadcasterId)).toThrow();
  });
});
