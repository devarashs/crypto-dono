import { describe, expect, it, vi } from 'vitest';
import { createChatBuffer, safeColor } from '../src/dashboard/chat.ts';
import { createDashboardHub } from '../src/dashboard/dashboard-hub.ts';
import { translateKickChat } from '../src/kick/kick-chat.ts';

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
      user: 'kicker',
      color: '#FF00AA',
      badges: ['moderator', 'subscriber'],
      text: 'hello KEKW gg',
    });
  });

  it('copes with a sender without identity, and ignores another channel', () => {
    const plain = payload({ sender: { username: 'plain', identity: null }, created_at: null });
    expect(translateKickChat(plain, '123', '2026-10-13T11:00:00Z')).toEqual({
      id: 'kick-msg_1',
      platform: 'kick',
      at: '2026-10-13T11:00:00Z',
      user: 'plain',
      badges: [],
      text: 'hello KEKW gg',
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
    const buffer = createChatBuffer(hub, 2);
    for (const id of ['a', 'b', 'c']) {
      buffer.add({ id, platform: 'twitch', at: 'now', user: 'u', badges: [], text: id });
    }
    expect(buffer.recent().map((message) => message.id)).toEqual(['b', 'c']);
    expect(received).toHaveBeenCalledTimes(3);
    expect(received).toHaveBeenLastCalledWith({ type: 'chat', message: expect.objectContaining({ id: 'c' }) });
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
