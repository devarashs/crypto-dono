/**
 * Twitch EventSub webhook messages: signature verification, freshness, and
 * translation into the platform-neutral StreamEvent.
 *
 * Docs: https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
 * The signature is HMAC-SHA256 over message id + timestamp + raw body, keyed
 * with the secret given when subscribing, sent as "sha256=<hex>".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { StreamEvent } from '../events/stream-event.ts';

/**
 * Messages older than this are refused even with a valid signature, so a
 * captured message cannot be replayed later. Twitch sends within seconds and
 * retries within minutes.
 */
export const maximumMessageAgeMs = 10 * 60 * 1000;

export type EventSubHeaders = {
  readonly messageId: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
};

/** True if the signature is valid for this exact body. Constant-time compare. */
export function verifyEventSubSignature(headers: EventSubHeaders, rawBody: string, secret: string): boolean {
  if (headers.messageId === undefined || headers.timestamp === undefined || headers.signature === undefined) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(headers.messageId + headers.timestamp + rawBody).digest('hex')}`,
  );
  const received = Buffer.from(headers.signature);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** True if the message timestamp is recent (and not implausibly in the future). */
export function isFreshMessage(timestamp: string, now: number): boolean {
  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt)) return false;
  return now - sentAt <= maximumMessageAgeMs && sentAt - now <= 60_000;
}

const name = z.string().min(1);
const eventSchemas = {
  'channel.follow': z.object({ user_name: name, broadcaster_user_id: z.string() }),
  'channel.subscribe': z.object({ user_name: name, broadcaster_user_id: z.string(), is_gift: z.boolean() }),
  'channel.subscription.message': z.object({
    user_name: name,
    broadcaster_user_id: z.string(),
    cumulative_months: z.number().int().nonnegative(),
    message: z.object({ text: z.string() }).loose().nullish(),
  }),
  'channel.subscription.gift': z.object({
    user_name: z.string().nullish(),
    broadcaster_user_id: z.string(),
    total: z.number().int().positive(),
    is_anonymous: z.boolean(),
  }),
  'channel.cheer': z.object({
    user_name: z.string().nullish(),
    broadcaster_user_id: z.string(),
    bits: z.number().int().positive(),
    message: z.string().nullish(),
    is_anonymous: z.boolean(),
  }),
  'channel.raid': z.object({
    from_broadcaster_user_name: name,
    to_broadcaster_user_id: z.string(),
    viewers: z.number().int().nonnegative(),
  }),
} as const;

export type EventTranslation =
  | { readonly outcome: 'event'; readonly event: StreamEvent }
  /** Deliberately not alerted, with the reason, e.g. a gift recipient's sub. */
  | { readonly outcome: 'ignored'; readonly reason: string };

/**
 * Turns an EventSub notification into a StreamEvent.
 *
 * @param broadcasterId The connected channel; events for any other channel are
 *   ignored, so a misconfigured subscription cannot put someone else's events
 *   on this stream.
 * @throws {z.ZodError} If a known event type arrives without the fields its
 *   documentation promises.
 */
export function translateEventSub(subscriptionType: string, event: unknown, broadcasterId: string): EventTranslation {
  const forOtherChannel = { outcome: 'ignored', reason: 'event for another channel' } as const;
  const anonymous = 'Anonymous';
  const platform = 'twitch' as const;

  switch (subscriptionType) {
    case 'channel.follow': {
      const data = eventSchemas[subscriptionType].parse(event);
      if (data.broadcaster_user_id !== broadcasterId) return forOtherChannel;
      return { outcome: 'event', event: { platform, kind: 'follow', actorName: data.user_name } };
    }
    case 'channel.subscribe': {
      const data = eventSchemas[subscriptionType].parse(event);
      if (data.broadcaster_user_id !== broadcasterId) return forOtherChannel;
      // Each gifted sub also arrives here, once per recipient; the gift itself
      // is announced once by channel.subscription.gift.
      if (data.is_gift) return { outcome: 'ignored', reason: 'gift recipient (announced by the gift event)' };
      return { outcome: 'event', event: { platform, kind: 'sub', actorName: data.user_name } };
    }
    case 'channel.subscription.message': {
      const data = eventSchemas[subscriptionType].parse(event);
      if (data.broadcaster_user_id !== broadcasterId) return forOtherChannel;
      const text = data.message?.text.trim() ?? '';
      return {
        outcome: 'event',
        event: {
          platform,
          kind: 'resub',
          actorName: data.user_name,
          months: data.cumulative_months,
          ...(text !== '' && { message: text }),
        },
      };
    }
    case 'channel.subscription.gift': {
      const data = eventSchemas[subscriptionType].parse(event);
      if (data.broadcaster_user_id !== broadcasterId) return forOtherChannel;
      const actorName = data.is_anonymous || !data.user_name ? anonymous : data.user_name;
      return { outcome: 'event', event: { platform, kind: 'gift', actorName, count: data.total } };
    }
    case 'channel.cheer': {
      const data = eventSchemas[subscriptionType].parse(event);
      if (data.broadcaster_user_id !== broadcasterId) return forOtherChannel;
      const actorName = data.is_anonymous || !data.user_name ? anonymous : data.user_name;
      const text = data.message?.trim() ?? '';
      return {
        outcome: 'event',
        event: { platform, kind: 'cheer', actorName, bits: data.bits, ...(text !== '' && { message: text }) },
      };
    }
    case 'channel.raid': {
      const data = eventSchemas[subscriptionType].parse(event);
      if (data.to_broadcaster_user_id !== broadcasterId) return forOtherChannel;
      return {
        outcome: 'event',
        event: { platform, kind: 'raid', actorName: data.from_broadcaster_user_name, viewers: data.viewers },
      };
    }
    default:
      return { outcome: 'ignored', reason: `unhandled subscription type ${subscriptionType}` };
  }
}
