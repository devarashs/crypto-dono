/**
 * Twitch EventSub webhook: POST /webhooks/twitch.
 *
 * Order matters: verify the signature on the raw body before trusting any of
 * it, refuse stale messages, then ignore duplicates (Twitch delivers "at least
 * once"). Twitch expects a reply within a few seconds and revokes subscriptions
 * that keep failing, so anything that cannot be acted on is still answered 2xx.
 *
 * Docs: https://dev.twitch.tv/docs/eventsub/handling-webhook-events/
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StreamEvent } from '../events/stream-event.ts';
import type { ConnectionStore } from '../platforms/connection-store.ts';
import { isFreshMessage, translateEventSub, verifyEventSubSignature } from '../twitch/eventsub.ts';

export const twitchWebhookPath = '/webhooks/twitch';

export type TwitchWebhookDependencies = {
  readonly connections: ConnectionStore;
  readonly eventSubSecret: string;
  /** Presents and publishes an event; false when its kind is switched off. */
  readonly publishEvent: (event: StreamEvent, alertId: string) => boolean;
  readonly now?: () => number;
};

const envelopeSchema = z.object({
  subscription: z.object({ type: z.string(), status: z.string().optional() }).loose(),
  challenge: z.string().optional(),
  event: z.unknown().optional(),
});

export function registerTwitchWebhookRoutes(app: FastifyInstance, dependencies: TwitchWebhookDependencies): void {
  const { connections, eventSubSecret, publishEvent } = dependencies;
  const now = dependencies.now ?? Date.now;

  // The signature covers the exact bytes Twitch sent, so keep the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body));

  app.post(twitchWebhookPath, async (request, reply) => {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const messageId = header('twitch-eventsub-message-id');
    const timestamp = header('twitch-eventsub-message-timestamp');
    const messageType = header('twitch-eventsub-message-type');

    if (!verifyEventSubSignature({ messageId, timestamp, signature: header('twitch-eventsub-message-signature') }, rawBody, eventSubSecret)) {
      request.log.warn('Rejected a Twitch message with a missing or invalid signature');
      return reply.code(403).send();
    }
    if (timestamp === undefined || !isFreshMessage(timestamp, now())) {
      request.log.warn({ timestamp }, 'Rejected a stale Twitch message');
      return reply.code(403).send();
    }

    const parsed = envelopeSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) {
      request.log.error({ issues: parsed.error.issues }, 'Signed Twitch message had an unexpected shape');
      return reply.code(400).send();
    }
    const message = parsed.data;
    const logContext = { messageId, type: messageType, subscriptionType: message.subscription.type };

    if (messageType === 'webhook_callback_verification') {
      // Twitch wants the challenge back verbatim as plain text; a JSON reply
      // would leave the subscription unverified.
      request.log.info(logContext, 'Confirmed a Twitch subscription');
      return reply.code(200).type('text/plain').send(message.challenge ?? '');
    }

    if (messageId === undefined || !connections.rememberMessage('twitch', messageId)) {
      request.log.info(logContext, 'Ignored a duplicate Twitch message');
      return reply.code(204).send();
    }

    if (messageType === 'revocation') {
      const reason = message.subscription.status ?? 'unknown';
      connections.markRevoked('twitch', reason);
      request.log.warn({ ...logContext, reason }, 'Twitch revoked a subscription; reconnect Twitch from the admin page');
      return reply.code(204).send();
    }

    if (messageType !== 'notification') return reply.code(204).send();

    const connection = connections.find('twitch');
    if (connection === undefined || connection.status !== 'active') {
      request.log.info(logContext, 'Ignored a Twitch event: Twitch is not connected');
      return reply.code(204).send();
    }

    try {
      const translation = translateEventSub(message.subscription.type, message.event, connection.accountId);
      if (translation.outcome === 'ignored') {
        request.log.info({ ...logContext, reason: translation.reason }, 'Ignored a Twitch event');
      } else {
        const published = publishEvent(translation.event, `twitch-${messageId}`);
        request.log.info({ ...logContext, kind: translation.event.kind, published }, 'Twitch event received');
      }
    } catch (error) {
      // Retrying a malformed event would not fix it; log it and acknowledge.
      request.log.error({ ...logContext, err: error }, 'Could not read a Twitch event');
    }
    return reply.code(204).send();
  });
}
