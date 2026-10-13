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
  /** The platform's id for the sender, so a ban can remove their messages. */
  readonly userId: string;
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

/** What a moderator removed: one message, one viewer's messages, or a whole platform's chat. */
export type ChatRemoval =
  | { readonly kind: 'message'; readonly id: string }
  | { readonly kind: 'user'; readonly platform: ChatMessage['platform']; readonly userId: string }
  | { readonly kind: 'all'; readonly platform: ChatMessage['platform'] };

function isRemovedBy(message: ChatMessage, removal: ChatRemoval): boolean {
  switch (removal.kind) {
    case 'message':
      return message.id === removal.id;
    case 'user':
      return message.platform === removal.platform && message.userId === removal.userId;
    case 'all':
      return message.platform === removal.platform;
  }
}

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
    /**
     * Drops what a moderator removed, here and on every open dashboard and
     * overlay. A removal for a message not (or no longer) held still goes out:
     * a page may show more than the buffer keeps.
     */
    remove(removal: ChatRemoval): void {
      const removedIds = messages.filter((message) => isRemovedBy(message, removal)).map((message) => message.id);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (isRemovedBy(messages[index]!, removal)) messages.splice(index, 1);
      }
      hub.publish({ type: 'chat-remove', removal, ids: removedIds });
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
