import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/dashboard/chat.ts';
import { createTwitchChatClient, parseIrcLine, toChatMessage, toChatRemoval, type ChatSocket } from '../src/twitch/twitch-chat.ts';
import type { ChatRemoval } from '../src/dashboard/chat.ts';

const privmsg =
  '@badge-info=subscriber/14;badges=moderator/1,subscriber/12;color=#1E90FF;display-name=NeonRider;emotes=25:6-10;' +
  'id=b34ccfc7-4977-403a-8a94-33c6bac34fb8;mod=1;tmi-sent-ts=1791850000000;user-id=9 ' +
  ':neonrider!neonrider@neonrider.tmi.twitch.tv PRIVMSG #machinearash :hello Kappa gg';

describe('parseIrcLine', () => {
  it('reads tags, prefix, command and the trailing text', () => {
    expect(parseIrcLine(`${privmsg}\r`)).toEqual({
      tags: expect.objectContaining({ badges: 'moderator/1,subscriber/12', 'display-name': 'NeonRider', color: '#1E90FF' }),
      prefix: 'neonrider!neonrider@neonrider.tmi.twitch.tv',
      command: 'PRIVMSG',
      params: ['#machinearash', 'hello Kappa gg'],
    });
  });

  it('unescapes tag values and reads plain commands', () => {
    expect(parseIrcLine('@system-msg=a\\sb\\:c :tmi.twitch.tv USERNOTICE #x')?.tags['system-msg']).toBe('a b;c');
    expect(parseIrcLine('PING :tmi.twitch.tv')).toEqual({ tags: {}, prefix: '', command: 'PING', params: ['tmi.twitch.tv'] });
    expect(parseIrcLine('')).toBeNull();
  });
});

describe('toChatMessage', () => {
  it('turns a chat line into a dashboard message', () => {
    expect(toChatMessage(parseIrcLine(privmsg)!)).toEqual({
      id: 'twitch-b34ccfc7-4977-403a-8a94-33c6bac34fb8',
      platform: 'twitch',
      at: new Date(1791850000000).toISOString(),
      userId: '9',
      user: 'NeonRider',
      color: '#1E90FF',
      badges: ['moderator', 'subscriber'],
      text: 'hello Kappa gg',
    });
  });

  it('unwraps /me, falls back to the login, and drops an unsafe colour', () => {
    const line = '@badges=;color=red;display-name=;id=x;tmi-sent-ts=1 :quiet!quiet@quiet.tmi.twitch.tv PRIVMSG #c :\u0001ACTION waves\u0001';
    expect(toChatMessage(parseIrcLine(line)!)).toEqual({
      id: 'twitch-x',
      platform: 'twitch',
      at: new Date(1).toISOString(),
      userId: 'quiet',
      user: 'quiet',
      badges: [],
      text: 'waves',
    });
  });

  it('ignores everything that is not a chat line', () => {
    expect(toChatMessage(parseIrcLine(':tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!')!)).toBeNull();
  });
});

describe('toChatRemoval', () => {
  it.each([
    ['@login=troll;target-msg-id=abc;tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #c :bad words', { kind: 'message', id: 'twitch-abc' }],
    ['@ban-duration=600;room-id=1;target-user-id=42;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c :troll', { kind: 'user', platform: 'twitch', userId: '42' }],
    ['@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c', { kind: 'all', platform: 'twitch' }],
  ])('%s', (line, expected) => {
    expect(toChatRemoval(parseIrcLine(line)!)).toEqual(expected);
  });

  it('ignores chat lines', () => {
    expect(toChatRemoval(parseIrcLine(privmsg)!)).toBeNull();
  });
});

/** A WebSocket stand-in that records what was sent and lets the test drive it. */
class FakeSocket implements ChatSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

describe('Twitch chat client', () => {
  let sockets: FakeSocket[];
  let channel: string | null;
  let received: ChatMessage[];
  let removals: ChatRemoval[];
  beforeEach(() => {
    removals = [];
    vi.useFakeTimers();
    sockets = [];
    channel = 'machinearash';
    received = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start() {
    const client = createTwitchChatClient({
      channel: () => channel,
      onMessage: (message) => received.push(message),
      onRemoval: (removal) => removals.push(removal),
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      channelCheckMs: 1000,
    });
    client.start();
    return client;
  }

  it('joins anonymously, answers pings, and passes chat on', () => {
    const client = start();
    sockets[0]!.emit('open');
    expect(sockets[0]!.sent).toEqual([
      'CAP REQ :twitch.tv/tags twitch.tv/commands',
      'PASS SCHMOOPIIE',
      expect.stringMatching(/^NICK justinfan\d+$/),
      'JOIN #machinearash',
    ]);
    sockets[0]!.emit('message', `PING :tmi.twitch.tv\r\n${privmsg}\r\n`);
    expect(sockets[0]!.sent.at(-1)).toBe('PONG :tmi.twitch.tv');
    expect(received.map((message) => message.text)).toEqual(['hello Kappa gg']);
    sockets[0]!.emit('message', '@target-user-id=9 :tmi.twitch.tv CLEARCHAT #machinearash :neonrider\r\n');
    expect(removals).toEqual([{ kind: 'user', platform: 'twitch', userId: '9' }]);
    client.stop();
  });

  it('reconnects with growing delays after drops, and on RECONNECT', async () => {
    const client = start();
    sockets[0]!.emit('open');
    sockets[0]!.emit('message', ':tmi.twitch.tv RECONNECT');
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    client.stop();
  });

  it('waits while Twitch is not connected, then joins; moves when the channel changes', async () => {
    channel = null;
    const client = start();
    expect(sockets).toHaveLength(0);
    channel = 'machinearash';
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit('open');
    channel = 'someoneelse';
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit('open');
    expect(sockets[1]!.sent).toContain('JOIN #someoneelse');
    channel = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[1]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('stops for good', async () => {
    const client = start();
    sockets[0]!.emit('open');
    client.stop();
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });
});
