/**
 * On-stream chat and viewer count, under the overlay token (registered by the
 * overlay routes, which check the token).
 *
 *   GET /overlay/:token/chat       chat for a Browser Source: no box, fading messages
 *   GET /overlay/:token/viewers    viewer count: total and per platform
 *   GET /overlay/:token/live       Server-Sent Events feeding both, and the scenes
 *
 * Chat here goes on stream, so unlike the private dashboard it is filtered:
 * banned words are masked in names and messages, and moderators' removals
 * (deletions, timeouts, bans) take messages off again.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BannedWordFilter } from '../alerts/banned-words.ts';
import type { ChatBuffer, ChatMessage } from '../dashboard/chat.ts';
import type { DashboardHub, DashboardMessage } from '../dashboard/dashboard-hub.ts';
import type { StreamStatusPoller } from '../dashboard/stream-status.ts';
import { html } from '../web/html.ts';
import { sendHtml } from './donation-routes.ts';

export type LiveOverlayDependencies = {
  readonly hub: DashboardHub;
  readonly chat: Pick<ChatBuffer, 'recent'>;
  readonly streamStatus?: Pick<StreamStatusPoller, 'current' | 'refresh'>;
  readonly bannedWords: BannedWordFilter;
  /** The overlay pages run their own script; nothing inline. */
  readonly contentSecurityPolicy: string;
};

/** How long a message stays on screen unless ?fade= says otherwise. */
const defaultFadeSeconds = 30;
/** Most messages on screen at once unless ?max= says otherwise. */
const defaultMaxMessages = 12;
const heartbeatIntervalMs = 15_000;

/** A whole number from the query, clamped; the default when absent or invalid. */
function clampedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

export function registerLiveOverlayRoutes(app: FastifyInstance, dependencies: LiveOverlayDependencies): void {
  const { hub, chat, streamStatus, bannedWords, contentSecurityPolicy } = dependencies;

  /** What may appear on stream: banned words masked, nothing else changed. */
  const forStream = (message: ChatMessage): ChatMessage => ({
    ...message,
    user: bannedWords.mask(message.user),
    text: bannedWords.mask(message.text),
    ...(message.fragments !== undefined && {
      fragments: message.fragments.map((fragment) => ('text' in fragment ? { text: bannedWords.mask(fragment.text) } : fragment)),
    }),
  });

  app.get<{ Querystring: { fade?: string; max?: string } }>('/overlay/:token/chat', async (request, reply) => {
    reply.header('content-security-policy', contentSecurityPolicy);
    const fadeSeconds = clampedNumber(request.query.fade, defaultFadeSeconds, 0, 3600);
    const maxMessages = clampedNumber(request.query.max, defaultMaxMessages, 1, 50);
    return sendHtml(
      reply,
      200,
      html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Chat</title>
    <link rel="stylesheet" href="/static/live-overlay.css">
    <script src="/static/chat-overlay.js" type="module"></script>
  </head>
  <!-- Relative to /overlay/<token>/chat, so the token is never written into the page. fade=0 keeps messages. -->
  <body class="chat-overlay" data-stream-url="live" data-fade-seconds="${fadeSeconds}" data-max-messages="${maxMessages}">
    <ol class="stream-chat" id="chat" aria-live="off"></ol>
  </body>
</html>`,
    );
  });

  app.get('/overlay/:token/viewers', async (_request, reply) => {
    reply.header('content-security-policy', contentSecurityPolicy);
    return sendHtml(
      reply,
      200,
      html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Viewers</title>
    <link rel="stylesheet" href="/static/live-overlay.css">
    <script src="/static/viewers-overlay.js" type="module"></script>
  </head>
  <body class="viewers-overlay" data-stream-url="live">
    <div class="viewer-pill" id="viewers" hidden></div>
  </body>
</html>`,
    );
  });

  app.get('/overlay/:token/live', async (request: FastifyRequest, reply: FastifyReply) => {
    // Hijacked like the alert stream: an event stream outlives send().
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    const write = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

    const send = (message: DashboardMessage) => {
      // Activity stays on the private dashboard; stream pages get chat and viewers.
      if (message.type === 'chat') write('chat', forStream(message.message));
      else if (message.type === 'chat-remove') write('chat-remove', { removal: message.removal });
      else if (message.type === 'status') write('status', message.statuses);
    };
    const unsubscribe = hub.subscribe(send);
    write('chat-snapshot', chat.recent().map(forStream));
    if (streamStatus !== undefined) {
      write('status', streamStatus.current());
      void streamStatus.refresh();
    }
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), heartbeatIntervalMs);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
