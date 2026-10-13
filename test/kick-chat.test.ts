import { describe, expect, it, vi } from 'vitest';
import { createChatBuffer, safeColor } from '../src/dashboard/chat.ts';
import { createDashboardHub } from '../src/dashboard/dashboard-hub.ts';
import { kickFragments, translateKickBan, translateKickChat } from '../src/kick/kick-chat.ts';

/** Shaped like the chat.message.sent example in Kick's docs. */
const payload = (overrides: Record<string, unknown> = {}) => ({
  message_id: 'msg_1',
  replies_to: null,
  broadcaster: { is_anonymous: false, user_id: 123, username: 'machinearash', is_verified: false, profile_picture: '', channel_slug: 'machinearash', identity: null },
  sender: {
    is_anonymous: false,
    user_id: 9,
    username: 'kicker',
    is_verified: false,
    profile_picture: '',
    channel_slug: 'kicker',
    identity: {
      username_color: '#FF00AA',
      badges: [
        { text: 'Moderator', type: 'moderator' },
        { text: 'Subscriber', type: 'subscriber', count: 3 },
      ],
    },
  },
  content: 'hello [emote:37226:KEKW] gg',
  emotes: [{ emote_id: '37226', positions: [{ s: 6, e: 22 }] }],
  created_at: '2026-10-13T10:00:00Z',
  ...overrides,
});

describe('translateKickChat', () => {
  it('reads the sender, colour, badges and text, emotes as their names', () => {
    expect(translateKickChat(payload(), '123', 'now')).toEqual({
      id: 'kick-msg_1',
      platform: 'kick',
      at: '2026-10-13T10:00:00Z',
      userId: '9',
      user: 'kicker',
      color: '#FF00AA',
      badges: ['moderator', 'subscriber'],
      text: 'hello KEKW gg',
      fragments: [{ text: 'hello ' }, { emote: 'KEKW', url: 'https://files.kick.com/emotes/37226/fullsize' }, { text: ' gg' }],
    });
  });

  it('copes with a sender without identity, and ignores another channel', () => {
    const plain = payload({ sender: { user_id: 10, username: 'plain', identity: null }, created_at: null });
    expect(translateKickChat(plain, '123', '2026-10-13T11:00:00Z')).toEqual({
      id: 'kick-msg_1',
      platform: 'kick',
      at: '2026-10-13T11:00:00Z',
      userId: '10',
      user: 'plain',
      badges: [],
      text: 'hello KEKW gg',
      fragments: [{ text: 'hello ' }, { emote: 'KEKW', url: 'https://files.kick.com/emotes/37226/fullsize' }, { text: ' gg' }],
    });
    expect(translateKickChat(payload(), '999', 'now')).toBeNull();
  });

  it('throws on a payload without the documented fields', () => {
    expect(() => translateKickChat({ content: 'hi' }, '123', 'now')).toThrow();
  });
});

describe('chat buffer', () => {
  it('keeps the latest messages only, oldest first, and tells open dashboards', () => {
    const hub = createDashboardHub();
    const received = vi.fn();
    hub.subscribe(received);
    const buffer = createChatBuffer(hub, { size: 2 });
    for (const id of ['a', 'b', 'c']) {
      buffer.add({ id, platform: 'twitch', at: 'now', userId: '1', user: 'u', badges: [], text: id });
    }
    expect(buffer.recent().map((message) => message.id)).toEqual(['b', 'c']);
    expect(received).toHaveBeenCalledTimes(3);
    expect(received).toHaveBeenLastCalledWith({ type: 'chat', message: expect.objectContaining({ id: 'c' }) });
  });
});

describe('kickFragments', () => {
  it('splits text and emotes, and leaves plain text alone', () => {
    expect(kickFragments('[emote:1:A][emote:2:B] hi')).toEqual([
      { emote: 'A', url: 'https://files.kick.com/emotes/1/fullsize' },
      { emote: 'B', url: 'https://files.kick.com/emotes/2/fullsize' },
      { text: ' hi' },
    ]);
    expect(kickFragments('no emotes [emote:x:bad]')).toBeUndefined();
  });
});

describe('translateKickBan', () => {
  it("removes a banned viewer's messages, only for this channel", () => {
    const ban = {
      broadcaster: { user_id: 123 },
      moderator: { user_id: 5, username: 'mod' },
      banned_user: { user_id: 9, username: 'troll' },
      metadata: { reason: 'spam', created_at: 'x', expires_at: null },
    };
    expect(translateKickBan(ban, '123')).toEqual({ kind: 'user', platform: 'kick', userId: '9' });
    expect(translateKickBan(ban, '999')).toBeNull();
  });
});

describe('chat removals', () => {
  const message = (id: string, platform: 'twitch' | 'kick', userId: string) => ({ id, platform, at: 'now', userId, user: 'u', badges: [], text: id });

  it('removes one message, one viewer, or a whole platform, and says which', () => {
    const hub = createDashboardHub();
    const received = vi.fn();
    const buffer = createChatBuffer(hub);
    for (const entry of [message('t1', 'twitch', 'a'), message('t2', 'twitch', 'b'), message('t3', 'twitch', 'a'), message('k1', 'kick', 'a')]) {
      buffer.add(entry);
    }
    hub.subscribe(received);

    buffer.remove({ kind: 'message', id: 't2' });
    expect(buffer.recent().map((entry) => entry.id)).toEqual(['t1', 't3', 'k1']);
    buffer.remove({ kind: 'user', platform: 'twitch', userId: 'a' });
    expect(buffer.recent().map((entry) => entry.id)).toEqual(['k1']);
    expect(received).toHaveBeenLastCalledWith({ type: 'chat-remove', removal: { kind: 'user', platform: 'twitch', userId: 'a' }, ids: ['t1', 't3'] });
    buffer.remove({ kind: 'all', platform: 'kick' });
    expect(buffer.recent()).toEqual([]);
  });
});

describe('safeColor', () => {
  it.each([
    ['#1E90FF', '#1E90FF'],
    ['red', undefined],
    ['#fff', undefined],
    ['#123456;background:url(x)', undefined],
    [null, undefined],
  ])('%j → %j', (input, expected) => {
    expect(safeColor(input)).toBe(expected);
  });
});
