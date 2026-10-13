/**
 * Chat for the live dashboard: messages from Twitch and Kick in one shape, and
 * an in-memory buffer of the latest few hundred.
 *
 * Never written to disk: the streamer chose (2026-10-13) that viewers' chat is
 * not stored. A restart empties the buffer; that is the point.
 */
import type { DashboardHub } from './dashboard-hub.ts';

export type ChatMessage = {
  /** The platform's message id, prefixed with the platform. */
  readonly id: string;
  readonly platform: 'twitch' | 'kick';
  /** ISO time the message was sent. */
  readonly at: string;
  readonly user: string;
  /** The colour the viewer picked, as #rrggbb, when they set one. */
  readonly color?: string;
  /** Lower-case badge types, e.g. "broadcaster", "moderator", "subscriber", "vip". */
  readonly badges: readonly string[];
  /** The text, with emotes written as their names. */
  readonly text: string;
};

/** Enough for the page to start with recent context. */
export const chatBufferSize = 300;

export type ChatBuffer = ReturnType<typeof createChatBuffer>;

export function createChatBuffer(hub: DashboardHub, size = chatBufferSize) {
  const messages: ChatMessage[] = [];
  return {
    /** Keeps the message and sends it to open dashboards. */
    add(message: ChatMessage): void {
      messages.push(message);
      if (messages.length > size) messages.splice(0, messages.length - size);
      hub.publish({ type: 'chat', message });
    },
    /** Oldest first. */
    recent(): readonly ChatMessage[] {
      return [...messages];
    },
  };
}

/** Accepts only a plain #rrggbb colour, so nothing else reaches a style. */
export function safeColor(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}
