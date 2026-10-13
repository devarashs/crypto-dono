/**
 * Kick chat messages (the chat.message.sent webhook) for the dashboard.
 *
 * Docs: https://docs.kick.com/events/event-types (checked 2026-10-13). Emotes
 * arrive inside the text as "[emote:<id>:<name>]"; they are shown as their name.
 */
import { z } from 'zod';
import { safeColor, type ChatMessage } from '../dashboard/chat.ts';

const chatSchema = z.object({
  message_id: z.string().min(1),
  broadcaster: z.object({ user_id: z.union([z.number(), z.string()]) }).loose(),
  sender: z
    .object({
      username: z.string().min(1),
      identity: z
        .object({
          username_color: z.string().nullish(),
          badges: z.array(z.object({ type: z.string() }).loose()).nullish(),
        })
        .loose()
        .nullish(),
    })
    .loose(),
  content: z.string(),
  created_at: z.string().nullish(),
});

/**
 * @returns The message, or `null` when it is for another channel.
 * @throws {z.ZodError} If the payload lacks the documented fields.
 */
export function translateKickChat(payload: unknown, broadcasterId: string, receivedAt: string): ChatMessage | null {
  const data = chatSchema.parse(payload);
  if (String(data.broadcaster.user_id) !== broadcasterId) return null;
  const color = safeColor(data.sender.identity?.username_color);
  return {
    id: `kick-${data.message_id}`,
    platform: 'kick',
    at: data.created_at ?? receivedAt,
    user: data.sender.username,
    ...(color !== undefined && { color }),
    badges: (data.sender.identity?.badges ?? []).map((badge) => badge.type.toLowerCase()),
    text: data.content.replace(/\[emote:\d+:([^\]]+)\]/g, '$1'),
  };
}
