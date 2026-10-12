import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKickPublicKeySource } from '../src/kick/kick-public-key.ts';
import { translateKickEvent, verifyKickSignature } from '../src/kick/kick-webhook.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** Signs as Kick's docs describe: RSA SHA-256 over "id.timestamp.body", base64. */
function kickSignature(messageId: string, timestamp: string, body: string): string {
  return sign('sha256', Buffer.from(`${messageId}.${timestamp}.${body}`), privateKey).toString('base64');
}

describe('verifyKickSignature', () => {
  const messageId = '01JX0000000000000000000000';
  const timestamp = '2026-10-13T10:00:00Z';
  const body = '{"broadcaster":{"user_id":123}}';
  const headers = { messageId, timestamp, signature: kickSignature(messageId, timestamp, body) };

  it('accepts a message signed with the key', () => {
    expect(verifyKickSignature(headers, body, publicKeyPem)).toBe(true);
  });

  it.each([
    ['a changed body', { ...headers }, `${body} `, publicKeyPem],
    ['a changed message id', { ...headers, messageId: `${messageId}X` }, body, publicKeyPem],
    ['a changed timestamp', { ...headers, timestamp: '2026-10-13T10:00:01Z' }, body, publicKeyPem],
    ['another key', headers, body, otherPem],
    ['a missing signature', { ...headers, signature: undefined }, body, publicKeyPem],
    ['a garbage signature', { ...headers, signature: 'not base64 at all!' }, body, publicKeyPem],
    ['a garbage key', headers, body, 'not a key'],
  ])('refuses %s', (_label, candidate, candidateBody, key) => {
    expect(verifyKickSignature(candidate, candidateBody, key)).toBe(false);
  });
});

describe('translateKickEvent', () => {
  const broadcasterId = '123';
  const broadcaster = { user_id: 123, username: 'machinearash', is_anonymous: false };
  const person = (username: string | null, isAnonymous = false) => ({
    user_id: username === null ? null : 9,
    username,
    is_anonymous: isAnonymous,
    is_verified: false,
    profile_picture: '',
    channel_slug: username,
    identity: null,
  });

  it('translates a follow', () => {
    expect(translateKickEvent('channel.followed', { broadcaster, follower: person('neon') }, broadcasterId)).toEqual({
      outcome: 'event',
      event: { platform: 'kick', kind: 'follow', actorName: 'neon' },
    });
  });

  it('translates a new sub and a renewal with its months', () => {
    const sub = { broadcaster, subscriber: person('sub_guy'), duration: 1, created_at: 'x', expires_at: 'y' };
    expect(translateKickEvent('channel.subscription.new', sub, broadcasterId)).toMatchObject({
      event: { kind: 'sub', actorName: 'sub_guy' },
    });
    expect(translateKickEvent('channel.subscription.renewal', { ...sub, duration: 6 }, broadcasterId)).toMatchObject({
      event: { kind: 'resub', actorName: 'sub_guy', months: 6 },
    });
  });

  it('announces a gift once with how many subs it carried, anonymous or not', () => {
    const gift = { broadcaster, gifter: person('generous'), giftees: [person('a'), person('b'), person('c')], created_at: 'x' };
    expect(translateKickEvent('channel.subscription.gifts', gift, broadcasterId)).toEqual({
      outcome: 'event',
      event: { platform: 'kick', kind: 'gift', actorName: 'generous', count: 3 },
    });
    expect(
      translateKickEvent('channel.subscription.gifts', { ...gift, gifter: person(null, true) }, broadcasterId),
    ).toMatchObject({ event: { actorName: 'Anonymous', count: 3 } });
  });

  it('translates Kicks with the amount and message', () => {
    const kicks = {
      broadcaster: { user_id: 123, username: 'machinearash' },
      sender: { user_id: 9, username: 'kicker' },
      gift: { amount: 100, name: 'Full Send', type: 'BASIC', tier: 'BASIC', message: ' w stream ', pinned_time_seconds: 0 },
      created_at: 'x',
    };
    expect(translateKickEvent('kicks.gifted', kicks, broadcasterId)).toEqual({
      outcome: 'event',
      event: { platform: 'kick', kind: 'kicks', actorName: 'kicker', kicks: 100, message: 'w stream' },
    });
    expect(translateKickEvent('kicks.gifted', { ...kicks, gift: { ...kicks.gift, message: '' } }, broadcasterId)).toEqual({
      outcome: 'event',
      event: { platform: 'kick', kind: 'kicks', actorName: 'kicker', kicks: 100 },
    });
  });

  it('ignores another channel and events that are not alerts', () => {
    expect(
      translateKickEvent('channel.followed', { broadcaster: { user_id: 999 }, follower: person('neon') }, broadcasterId),
    ).toEqual({ outcome: 'ignored', reason: 'event for another channel' });
    expect(translateKickEvent('chat.message.sent', {}, broadcasterId)).toMatchObject({ outcome: 'ignored' });
  });

  it('throws on a known event missing its documented fields', () => {
    expect(() => translateKickEvent('kicks.gifted', { broadcaster, sender: person('x') }, broadcasterId)).toThrow();
  });
});

describe('createKickPublicKeySource', () => {
  const okResponse = () => new Response(JSON.stringify({ data: { public_key: publicKeyPem }, message: 'OK' }));

  it('fetches the key once and keeps it', async () => {
    let calls = 0;
    const source = createKickPublicKeySource({ fetch: async () => (calls++, okResponse()) });
    expect(await source.current()).toBe(publicKeyPem);
    expect(await source.current()).toBe(publicKeyPem);
    expect(calls).toBe(1);
  });

  it('refreshes at most once every five minutes', async () => {
    let calls = 0;
    let clock = 0;
    const source = createKickPublicKeySource({ fetch: async () => (calls++, okResponse()), now: () => clock });
    await source.current();
    expect(await source.refresh()).toBeNull();
    clock = 5 * 60 * 1000;
    expect(await source.refresh()).toBe(publicKeyPem);
    expect(calls).toBe(2);
  });

  it('reports an unreachable Kick without throwing on refresh', async () => {
    const source = createKickPublicKeySource({ fetch: async () => new Response('down', { status: 503 }) });
    await expect(source.current()).rejects.toThrow('HTTP 503');
    expect(await source.refresh()).toBeNull();
  });
});
