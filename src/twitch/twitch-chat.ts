/**
 * Read-only Twitch chat for the live dashboard, joined anonymously.
 *
 * Twitch chat is IRC over a WebSocket; a "justinfan" nickname reads any public
 * channel without logging in, so no token or scope is involved and nothing can
 * be sent. Docs: https://dev.twitch.tv/docs/chat/irc/ (anonymous connections,
 * tags, PING, RECONNECT).
 */
import { safeColor, type ChatMessage } from '../dashboard/chat.ts';

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
  return {
    id: `twitch-${message.tags.id || `${login}-${message.tags['tmi-sent-ts'] ?? ''}`}`,
    platform: 'twitch',
    at: Number.isFinite(sentAt) && sentAt > 0 ? new Date(sentAt).toISOString() : now().toISOString(),
    user: message.tags['display-name'] || login,
    ...(color !== undefined && { color }),
    badges: (message.tags.badges ?? '')
      .split(',')
      .map((badge) => badge.split('/')[0] ?? '')
      .filter((badge) => badge !== ''),
    text,
  };
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
