/**
 * The OBS overlay: a transparent page added to OBS as a Browser Source.
 *
 *   GET  /overlay/:token                      the page
 *   GET  /overlay/:token/events               Server-Sent Events stream of alerts
 *   POST /overlay/:token/alerts/:id/shown     the overlay finished showing an alert
 *
 * The token in the path is the only credential: OBS cannot send headers or log
 * in, so the URL itself is the secret. A wrong token answers 404 so the overlay's
 * existence is not confirmed to someone guessing.
 *
 * Server-Sent Events rather than WebSockets: delivery is one-way, EventSource
 * reconnects by itself, and it passes through tunnels and proxies as plain HTTP.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toOverlayAlert, type AlertHub, type OverlayAlert } from '../alerts/alert-hub.ts';
import type { Config } from '../config.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import { html } from '../web/html.ts';
import { sendHtml } from './donation-routes.ts';

/** Pending alerts older than this are not replayed, so a long-closed OBS does not flood the stream. */
export const alertReplayWindowMs = 24 * 60 * 60 * 1000;

/**
 * Comment line sent periodically on the event stream. Cloudflare and most
 * proxies close a response that is silent for about 100 seconds.
 */
const heartbeatIntervalMs = 15_000;

/** How long each alert stays on screen. Becomes configurable with the alert styling. */
const alertDurationMs = 8_000;

export type OverlayRouteDependencies = {
  readonly config: Config;
  readonly donations: DonationRepository;
  readonly alertHub: AlertHub;
  /** Injected for tests. */
  readonly now?: () => Date;
};

/** The overlay runs a script, so it needs a looser policy than the script-free public pages. */
const overlayContentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; media-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

type TokenParams = { token: string };

export function registerOverlayRoutes(app: FastifyInstance, dependencies: OverlayRouteDependencies): void {
  const { config, donations, alertHub } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const expectedToken = Buffer.from(config.overlayToken);

  function hasValidToken(token: string): boolean {
    const presented = Buffer.from(token);
    return presented.length === expectedToken.length && timingSafeEqual(presented, expectedToken);
  }

  // Rejects every overlay route with a wrong token before its handler runs.
  app.addHook('preHandler', async (request: FastifyRequest<{ Params: Partial<TokenParams> }>, reply) => {
    if (typeof request.params.token !== 'string' || !hasValidToken(request.params.token)) {
      return reply.callNotFound();
    }
  });

  app.get<{ Params: TokenParams }>('/overlay/:token', async (request, reply) => {
    reply.header('content-security-policy', overlayContentSecurityPolicy);
    // Relative to the page, so the token never needs to be written into the HTML.
    const page = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Donation alerts</title>
    <link rel="stylesheet" href="/static/overlay.css">
    <script src="/static/overlay.js" defer></script>
  </head>
  <body data-events-url="${request.params.token}/events" data-alert-duration-ms="${alertDurationMs}">
    <div id="alert-stage" aria-live="polite"></div>
  </body>
</html>`;
    return sendHtml(reply, 200, page);
  });

  app.get<{ Params: TokenParams }>('/overlay/:token/events', (request, reply) => {
    streamAlerts(request, reply);
  });

  app.post<{ Params: TokenParams & { id: string } }>('/overlay/:token/alerts/:id/shown', async (request, reply) => {
    // Unknown or already-acknowledged ids are fine: several overlays (preview and
    // program in OBS) can show the same alert and each acknowledges it.
    donations.markAlertShown(request.params.id);
    return reply.code(204).send();
  });

  function streamAlerts(request: FastifyRequest, reply: FastifyReply): void {
    // Fastify's reply lifecycle ends at send(); an event stream stays open, so the
    // raw response is taken over. Hooks such as the security headers do not run
    // on a hijacked reply, which is acceptable for a text/event-stream response.
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx-style proxies not to buffer the stream.
      'x-accel-buffering': 'no',
    });
    // Reconnect quickly after a drop; EventSource's default is several seconds.
    response.write('retry: 3000\n\n');

    const sentIds = new Set<string>();
    const send = (alert: OverlayAlert) => {
      if (sentIds.has(alert.id)) return;
      sentIds.add(alert.id);
      response.write(`id: ${alert.id}\nevent: alert\ndata: ${JSON.stringify(alert)}\n\n`);
    };

    // Subscribed before the backlog query, so an alert arriving in between is not
    // missed; `sentIds` stops it being sent twice.
    const unsubscribe = alertHub.subscribe(send);
    const replayCutoff = new Date(now().getTime() - alertReplayWindowMs).toISOString();
    for (const donation of donations.listPendingAlerts(replayCutoff)) send(toOverlayAlert(donation));

    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), heartbeatIntervalMs);
    request.log.info({ subscribers: alertHub.subscriberCount }, 'Overlay connected');

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      request.log.info({ subscribers: alertHub.subscriberCount }, 'Overlay disconnected');
    });
  }
}
