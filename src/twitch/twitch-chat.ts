/**
 * Read-only Twitch chat for the live dashboard, joined anonymously.
 *
 * Twitch chat is IRC over a WebSocket; a "justinfan" nickname reads any public
 * channel without logging in, so no token or scope is involved and nothing can
 * be sent. Docs: https://dev.twitch.tv/docs/chat/irc/ (anonymous connections,
 * tags, PING, RECONNECT).
 */
import { safeColor, type ChatFragment, type ChatMessage, type ChatRemoval } from '../dashboard/chat.ts';

export const twitchChatUrl = 'wss://irc-ws.chat.twitch.tv:443';

export type IrcMessage = {
  readonly tags: Readonly<Record<string, string>>;
  /** e.g. "nick!nick@nick.tmi.twitch.tv" or "tmi.twitch.tv". */
  readonly prefix: string;
  readonly command: string;
  readonly params: readonly string[];
};

/** Undoes IRCv3 tag escaping. */
function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_match, character: string) =>
    character === ':' ? ';' : character === 's' ? ' ' : character === 'r' ? '\r' : character === 'n' ? '\n' : character,
  );
}

/** Parses one IRC line; `null` for an empty or malformed one. */
export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line.replace(/\r$/, '');
  if (rest === '') return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    for (const pair of rest.slice(1, end).split(';')) {
      const equals = pair.indexOf('=');
      if (equals === -1) tags[pair] = '';
      else tags[pair.slice(0, equals)] = unescapeTag(pair.slice(equals + 1));
    }
    rest = rest.slice(end + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const trailingAt = rest.indexOf(' :');
  const head = trailingAt === -1 ? rest : rest.slice(0, trailingAt);
  const [command = '', ...params] = head.split(' ').filter((part) => part !== '');
  if (trailingAt !== -1) params.push(rest.slice(trailingAt + 2));
  if (command === '') return null;
  return { tags, prefix, command, params };
}

/**
 * Splits a message by Twitch's emotes tag ("25:0-4,12-16/1902:6-10"): emote
 * ids with inclusive character ranges, counted in code points. Third-party
 * emotes (7TV, BTTV, FFZ) are not in the tag and stay text.
 *
 * @returns The fragments, or `undefined` when there are no (valid) emotes.
 */
export function twitchFragments(text: string, emotesTag: string | undefined): ChatFragment[] | undefined {
  if (!emotesTag) return undefined;
  const characters = Array.from(text);
  const ranges: { start: number; end: number; id: string }[] = [];
  for (const entry of emotesTag.split('/')) {
    const [id = '', positions = ''] = entry.split(':');
    // Ids are numbers or "emotesv2_<hex>"; anything else is not put in a URL.
    if (!/^[A-Za-z0-9_]+$/.test(id)) continue;
    for (const position of positions.split(',')) {
      const [start, end] = position.split('-').map(Number);
      if (Number.isInteger(start) && Number.isInteger(end) && start! <= end! && end! < characters.length) {
        ranges.push({ start: start!, end: end!, id });
      }
    }
  }
  if (ranges.length === 0) return undefined;
  ranges.sort((first, second) => first.start - second.start);
  const fragments: ChatFragment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue; // Overlapping ranges: keep the first.
    if (range.start > cursor) fragments.push({ text: characters.slice(cursor, range.start).join('') });
    fragments.push({
      emote: characters.slice(range.start, range.end + 1).join(''),
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${range.id}/default/dark/2.0`,
    });
    cursor = range.end + 1;
  }
  if (cursor < characters.length) fragments.push({ text: characters.slice(cursor).join('') });
  return fragments;
}

/** A chat line as a dashboard message; `null` for anything that is not one. */
export function toChatMessage(message: IrcMessage, now: () => Date = () => new Date()): ChatMessage | null {
  if (message.command !== 'PRIVMSG') return null;
  const login = message.prefix.split('!')[0] ?? '';
  let text = message.params[1] ?? '';
  // "/me waves" arrives wrapped as a CTCP ACTION.
  const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
  if (action !== null) text = action[1] ?? '';
  const sentAt = Number(message.tags['tmi-sent-ts']);
  const color = safeColor(message.tags.color);
  const fragments = twitchFragments(text, message.tags.emotes);
  return {
    id: `twitch-${message.tags.id || `${login}-${message.tags['tmi-sent-ts'] ?? ''}`}`,
    platform: 'twitch',
    at: Number.isFinite(sentAt) && sentAt > 0 ? new Date(sentAt).toISOString() : now().toISOString(),
    userId: message.tags['user-id'] || login,
    user: message.tags['display-name'] || login,
    ...(color !== undefined && { color }),
    badges: (message.tags.badges ?? '')
      .split(',')
      .map((badge) => badge.split('/')[0] ?? '')
      .filter((badge) => badge !== ''),
    text,
    ...(fragments !== undefined && { fragments }),
  };
}

/**
 * A moderator's action, from CLEARMSG (one message deleted) or CLEARCHAT (a
 * viewer timed out or banned, or the whole chat cleared); `null` otherwise.
 */
export function toChatRemoval(message: IrcMessage): ChatRemoval | null {
  if (message.command === 'CLEARMSG') {
    const target = message.tags['target-msg-id'];
    return target ? { kind: 'message', id: `twitch-${target}` } : null;
  }
  if (message.command === 'CLEARCHAT') {
    const userId = message.tags['target-user-id'];
    return userId ? { kind: 'user', platform: 'twitch', userId } : { kind: 'all', platform: 'twitch' };
  }
  return null;
}

/** The parts of the WebSocket API this client uses; injected for tests. */
export type ChatSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

export type TwitchChatOptions = {
  /** The channel to read, as its login; `null` while Twitch is not connected. */
  readonly channel: () => string | null;
  readonly onMessage: (message: ChatMessage) => void;
  /** A moderator removed messages; absent when nothing needs to know. */
  readonly onRemoval?: (removal: ChatRemoval) => void;
  readonly log?: (message: string) => void;
  readonly openSocket?: (url: string) => ChatSocket;
  /** How often to notice that the channel changed (connected, disconnected). */
  readonly channelCheckMs?: number;
};

const maximumBackoffMs = 60_000;

export type TwitchChatClient = ReturnType<typeof createTwitchChatClient>;

export function createTwitchChatClient(options: TwitchChatOptions) {
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url) as unknown as ChatSocket);
  const log = options.log ?? (() => {});
  let socket: ChatSocket | undefined;
  let joined: string | null = null;
  let stopped = true;
  let failures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let channelTimer: ReturnType<typeof setInterval> | undefined;

  function connect(): void {
    const channel = options.channel();
    if (stopped || channel === null) return;
    const current = openSocket(twitchChatUrl);
    socket = current;
    current.addEventListener('open', () => {
      current.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      // Anonymous: any password, and a justinfan nickname.
      current.send('PASS SCHMOOPIIE');
      current.send(`NICK justinfan${Math.floor(10_000 + Math.random() * 89_999)}`);
      current.send(`JOIN #${channel}`);
      joined = channel;
      failures = 0;
      log(`Twitch chat: reading #${channel}`);
    });
    current.addEventListener('message', (event) => {
      for (const line of String(event.data).split('\n')) {
        const message = parseIrcLine(line);
        if (message === null) continue;
        if (message.command === 'PING') current.send(`PONG :${message.params[0] ?? 'tmi.twitch.tv'}`);
        // Twitch is about to restart this server: reconnect now rather than be dropped.
        else if (message.command === 'RECONNECT') current.close();
        else {
          const chat = toChatMessage(message);
          if (chat !== null) options.onMessage(chat);
          const removal = toChatRemoval(message);
          if (removal !== null) options.onRemoval?.(removal);
        }
      }
    });
    current.addEventListener('error', () => {
      // A close always follows, which schedules the reconnect.
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      socket = undefined;
      joined = null;
      if (stopped) return;
      failures += 1;
      const delay = Math.min(1000 * 2 ** (failures - 1), maximumBackoffMs);
      log(`Twitch chat: disconnected, retrying in ${Math.round(delay / 1000)} s`);
      scheduleConnect(delay);
    });
  }

  function scheduleConnect(delay: number): void {
    if (reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  /** Joins when Twitch gets connected, moves when it changes, leaves when it is disconnected. */
  function followChannel(): void {
    const channel = options.channel();
    // Waiting to reconnect: that attempt will read the channel itself.
    if (reconnectTimer !== undefined) return;
    if (socket !== undefined) {
      // Still opening (not yet joined) or already on the right channel.
      if (joined === null || joined === channel) return;
      // Detached first, so its close does not schedule a retry.
      const old = socket;
      socket = undefined;
      joined = null;
      old.close();
    }
    if (channel !== null) connect();
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      connect();
      channelTimer = setInterval(followChannel, options.channelCheckMs ?? 60_000);
      channelTimer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      if (channelTimer !== undefined) clearInterval(channelTimer);
      socket?.close();
      socket = undefined;
      joined = null;
    },
  };
}
