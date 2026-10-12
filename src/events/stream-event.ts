/**
 * Platform events that alert on stream alongside donations: follows, subs,
 * gift subs, cheers and raids. Each platform integration (Twitch, Kick, ...)
 * translates its own payloads into this one shape, so the overlay and its
 * settings never need to know which platform an event came from.
 */

/** Platforms an event can come from. "test" is the test-alert page. */
export const streamPlatforms = ['twitch', 'kick', 'youtube', 'test'] as const;
export type StreamPlatform = (typeof streamPlatforms)[number];

/**
 * Kinds of event. "resub" is a subscription announced with its month count;
 * it shares the "sub" on/off switch and sound but has its own wording. "kicks"
 * is Kick's paid gift, its counterpart to Twitch bits: it shares the "cheer"
 * switch and sound but has its own wording.
 */
export const streamEventKinds = ['follow', 'sub', 'resub', 'gift', 'cheer', 'kicks', 'raid'] as const;
export type StreamEventKind = (typeof streamEventKinds)[number];

/** Kinds the streamer can switch on and off with EVENT_ALERTS. */
export const switchableEventKinds = ['follow', 'sub', 'gift', 'cheer', 'raid'] as const;
export type SwitchableEventKind = (typeof switchableEventKinds)[number];

/** The switch that controls a kind: resubs follow "sub", Kicks follow "cheer". */
export function switchFor(kind: StreamEventKind): SwitchableEventKind {
  if (kind === 'resub') return 'sub';
  if (kind === 'kicks') return 'cheer';
  return kind;
}

export type StreamEvent = {
  readonly platform: StreamPlatform;
  readonly kind: StreamEventKind;
  /** Who did it: the follower, subscriber, gifter, cheerer or raiding channel. */
  readonly actorName: string;
  /** Resub: cumulative months subscribed. */
  readonly months?: number;
  /** Gift: how many subs were gifted in this one gift. */
  readonly count?: number;
  /** Cheer: bits cheered. */
  readonly bits?: number;
  /** Kicks: how many Kicks were sent. */
  readonly kicks?: number;
  /** Raid: viewers brought along. */
  readonly viewers?: number;
  /** Resub, cheer or Kicks message, as the viewer typed it. */
  readonly message?: string;
};

/** Wording used when the streamer has not set EVENT_TEMPLATE_<KIND>. */
export const defaultEventTemplates: Readonly<Record<StreamEventKind, string>> = {
  follow: '{name} just followed',
  sub: '{name} subscribed',
  resub: '{name} resubscribed for {months} months',
  gift: '{name} gifted {count} {subs}',
  cheer: '{name} cheered {bits} bits',
  kicks: '{name} sent {kicks} Kicks',
  raid: '{name} is raiding with {viewers} viewers',
};
