/**
 * Kick webhooks: POST /webhooks/kick, the URL set once in the Kick app's
 * settings.
 *
 * Same order as Twitch: verify the signature on the raw body before trusting
 * any of it, refuse stale messages, ignore duplicates, then act. Anything that
 * cannot be acted on is still answered 2xx, so Kick does not keep retrying it.
 *
 * Docs: https://docs.kick.com/events/webhook-security
 */
import type { FastifyInstance } from 'fastify';
import type { StreamEvent } from '../events/stream-event.ts';
import type { KickPublicKeySource } from '../kick/kick-public-key.ts';
import { translateKickEvent, verifyKickSignature } from '../kick/kick-webhook.ts';
import type { ConnectionStore } from '../platforms/connection-store.ts';
import { isFreshMessage } from '../platforms/message-freshness.ts';
import type { ChatMessage } from '../dashboard/chat.ts';
import { translateKickChat } from '../kick/kick-chat.ts';

export const kickWebhookPath = '/webhooks/kick';

export type KickWebhookDependencies = {
  readonly connections: ConnectionStore;
  readonly publicKey: KickPublicKeySource;
  /** Presents and publishes an event; false when its kind is switched off. */
  readonly publishEvent: (event: StreamEvent, alertId: string) => boolean;
  /** Hands a chat message to the live dashboard; absent when nothing shows chat. */
  readonly onChatMessage?: (message: ChatMessage) => void;
  readonly now?: () => number;
};

/**
 * A renewal's "duration", logged so it can be compared with the viewer's badge
 * on Kick and settle whether it counts total months (ROADMAP item 28).
 */
function renewalDuration(eventType: string, payload: unknown): { duration?: unknown } {
  if (eventType !== 'channel.subscription.renewal' || typeof payload !== 'object' || payload === null) return {};
  return { duration: (payload as Record<string, unknown>).duration };
}

export function registerKickWebhookRoutes(app: FastifyInstance, dependencies: KickWebhookDependencies): void {
  const { connections, publicKey, publishEvent, onChatMessage } = dependencies;
  const now = dependencies.now ?? Date.now;

  // The signature covers the exact bytes Kick sent, so keep the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.post(kickWebhookPath, async (request, reply) => {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const messageId = header('kick-event-message-id');
    const timestamp = header('kick-event-message-timestamp');
    const eventType = header('kick-event-type') ?? '';
    const signatureHeaders = { messageId, timestamp, signature: header('kick-event-signature') };

    let key: string;
    try {
      key = await publicKey.current();
    } catch (error) {
      // Without Kick's key nothing can be verified; 503 asks Kick to retry later.
      request.log.error({ err: error }, "Could not fetch Kick's public key");
      return reply.code(503).send();
    }
    if (!verifyKickSignature(signatureHeaders, rawBody, key)) {
      // Kick may have rotated its key: fetch it again (throttled) and retry once.
      const freshKey = await publicKey.refresh();
      if (freshKey === null || !verifyKickSignature(signatureHeaders, rawBody, freshKey)) {
        request.log.warn({ eventType }, 'Rejected a Kick message with a missing or invalid signature');
        return reply.code(403).send();
      }
    }
    if (timestamp === undefined || !isFreshMessage(timestamp, now())) {
      request.log.warn({ timestamp }, 'Rejected a stale Kick message');
      return reply.code(403).send();
    }

    const logContext = { messageId, eventType };
    if (messageId === undefined || !connections.rememberMessage('kick', messageId)) {
      request.log.info(logContext, 'Ignored a duplicate Kick message');
      return reply.code(200).send();
    }

    const connection = connections.find('kick');
    if (connection === undefined || connection.status !== 'active') {
      request.log.info(logContext, 'Ignored a Kick event: Kick is not connected');
      return reply.code(200).send();
    }

    if (eventType === 'chat.message.sent') {
      try {
        const message = translateKickChat(JSON.parse(rawBody), connection.accountId, new Date(now()).toISOString());
        if (message !== null) onChatMessage?.(message);
      } catch (error) {
        // Logged without the message itself: chat is not kept anywhere.
        request.log.error({ ...logContext, err: (error as Error).message }, 'Could not read a Kick chat message');
      }
      return reply.code(200).send();
    }

    try {
      const payload: unknown = JSON.parse(rawBody);
      const translation = translateKickEvent(eventType, payload, connection.accountId);
      if (translation.outcome === 'ignored') {
        request.log.info({ ...logContext, reason: translation.reason }, 'Ignored a Kick event');
      } else {
        const published = publishEvent(translation.event, `kick-${messageId}`);
        request.log.info(
          { ...logContext, kind: translation.event.kind, published, ...renewalDuration(eventType, payload) },
          'Kick event received',
        );
      }
    } catch (error) {
      // Retrying a malformed event would not fix it; log it and acknowledge.
      request.log.error({ ...logContext, err: error }, 'Could not read a Kick event');
    }
    return reply.code(200).send();
  });
}
