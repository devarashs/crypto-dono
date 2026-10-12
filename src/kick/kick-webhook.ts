/**
 * Kick webhook messages: signature verification and translation into the
 * platform-neutral StreamEvent.
 *
 * Docs: https://docs.kick.com/events/webhook-security and
 * https://docs.kick.com/events/event-types (checked 2026-10-13).
 * Kick signs "<message id>.<timestamp>.<raw body>" with its private key: RSA,
 * PKCS#1 v1.5 padding over SHA-256, sent base64 in Kick-Event-Signature. The
 * public key is fetched from Kick (see kick-public-key.ts).
 */
import { verify } from 'node:crypto';
import { z } from 'zod';
import type { StreamEvent } from '../events/stream-event.ts';

export type KickSignatureHeaders = {
  readonly messageId: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
};

/** True if Kick's signature is valid for this exact body under this public key. */
export function verifyKickSignature(headers: KickSignatureHeaders, rawBody: string, publicKeyPem: string): boolean {
  if (headers.messageId === undefined || headers.timestamp === undefined || headers.signature === undefined) {
    return false;
  }
  try {
    return verify(
      'sha256',
      Buffer.from(`${headers.messageId}.${headers.timestamp}.${rawBody}`),
      publicKeyPem,
      Buffer.from(headers.signature, 'base64'),
    );
  } catch {
    // A malformed key or signature is simply not a valid signature.
    return false;
  }
}

/** Kick's user object; username is null for an anonymous gifter. */
const user = z.object({
  user_id: z.union([z.number(), z.string()]).nullish(),
  username: z.string().nullish(),
  is_anonymous: z.boolean().optional(),
});
const broadcaster = z.object({ user_id: z.union([z.number(), z.string()]) });

const eventSchemas = {
  'channel.followed': z.object({ broadcaster, follower: user }),
  'channel.subscription.new': z.object({ broadcaster, subscriber: user }),
  'channel.subscription.renewal': z.object({
    broadcaster,
    subscriber: user,
    duration: z.number().int().positive(),
  }),
  'channel.subscription.gifts': z.object({ broadcaster, gifter: user.nullish(), giftees: z.array(user) }),
  'kicks.gifted': z.object({
    broadcaster,
    sender: user,
    gift: z.object({ amount: z.number().int().positive(), message: z.string().nullish() }).loose(),
  }),
} as const;

export type KickTranslation =
  | { readonly outcome: 'event'; readonly event: StreamEvent }
  | { readonly outcome: 'ignored'; readonly reason: string };

/**
 * Turns a Kick webhook into a StreamEvent.
 *
 * @param eventType The Kick-Event-Type header, e.g. "channel.followed".
 * @param payload The parsed body.
 * @param broadcasterId The connected channel's Kick user id; events for any
 *   other channel are ignored.
 * @throws {z.ZodError} If a known event type arrives without the fields its
 *   documentation promises.
 */
export function translateKickEvent(eventType: string, payload: unknown, broadcasterId: string): KickTranslation {
  const platform = 'kick' as const;
  const isOtherChannel = (data: { broadcaster: { user_id: number | string } }) =>
    String(data.broadcaster.user_id) !== broadcasterId;
  const forOtherChannel = { outcome: 'ignored', reason: 'event for another channel' } as const;
  /** A name to show; Anonymous when Kick hides or omits it. */
  const nameOf = (person: z.infer<typeof user> | null | undefined) =>
    person === null || person === undefined || person.is_anonymous === true || !person.username
      ? 'Anonymous'
      : person.username;

  switch (eventType) {
    case 'channel.followed': {
      const data = eventSchemas[eventType].parse(payload);
      if (isOtherChannel(data)) return forOtherChannel;
      return { outcome: 'event', event: { platform, kind: 'follow', actorName: nameOf(data.follower) } };
    }
    case 'channel.subscription.new': {
      const data = eventSchemas[eventType].parse(payload);
      if (isOtherChannel(data)) return forOtherChannel;
      return { outcome: 'event', event: { platform, kind: 'sub', actorName: nameOf(data.subscriber) } };
    }
    case 'channel.subscription.renewal': {
      const data = eventSchemas[eventType].parse(payload);
      if (isOtherChannel(data)) return forOtherChannel;
      // Kick's "duration" may be the months subscribed so far or only the
      // length of this renewal; until a real renewal settles it, the alert
      // shows no number (see ROADMAP item 28). The route logs the duration.
      return { outcome: 'event', event: { platform, kind: 'resub', actorName: nameOf(data.subscriber) } };
    }
    case 'channel.subscription.gifts': {
      const data = eventSchemas[eventType].parse(payload);
      if (isOtherChannel(data)) return forOtherChannel;
      // One alert for the whole gift, however many people received a sub.
      const count = Math.max(data.giftees.length, 1);
      return { outcome: 'event', event: { platform, kind: 'gift', actorName: nameOf(data.gifter), count } };
    }
    case 'kicks.gifted': {
      const data = eventSchemas[eventType].parse(payload);
      if (isOtherChannel(data)) return forOtherChannel;
      const text = data.gift.message?.trim() ?? '';
      return {
        outcome: 'event',
        event: {
          platform,
          kind: 'kicks',
          actorName: nameOf(data.sender),
          kicks: data.gift.amount,
          ...(text !== '' && { message: text }),
        },
      };
    }
    default:
      return { outcome: 'ignored', reason: `not an alert event (${eventType})` };
  }
}
