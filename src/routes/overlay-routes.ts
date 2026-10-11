/**
 * The OBS overlay: a transparent page added to OBS as a Browser Source.
 *
 *   GET  /overlay/:token                      the page
 *   GET  /overlay/:token/events               Server-Sent Events stream of alerts
 *   POST /overlay/:token/alerts/:id/shown     the overlay finished showing an alert
 *   GET  /overlay/:token/assets/sound         the streamer's custom alert sound, if set
 *   GET  /overlay/:token/assets/image         the streamer's custom alert image, if set
 *   GET  /overlay/:token/alerts/:id/speech    the alert read aloud, as WAV, if TTS is on
 *   GET  /overlay/:token/board                on-stream table of the biggest donations
 *   GET  /overlay/:token/board.json           its data, polled by the table
 *   GET  /overlay/:token/test                 form for sending a test alert
 *   POST /overlay/:token/test                 send a test alert to connected overlays
 *
 * The token in the path is the only credential: OBS cannot send headers or log
 * in, so the URL itself is the secret. A wrong token answers 404 so the overlay's
 * existence is not confirmed to someone guessing.
 *
 * Server-Sent Events rather than WebSockets: delivery is one-way, EventSource
 * reconnects by itself, and it passes through tunnels and proxies as plain HTTP.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AlertHub, OverlayAlert } from '../alerts/alert-hub.ts';
import { createBannedWordFilter } from '../alerts/banned-words.ts';
import { donationToAlertSource, type AlertPresenter, type PresentedAlert } from '../alerts/alert-presenter.ts';
import type { Config } from '../config.ts';
import type { AlertSpeech } from '../tts/alert-speech.ts';
import { validateDonationForm, type DonationFormValues } from '../donations/donation-form.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import type { LeaderboardQueries } from '../donations/leaderboard.ts';
import { formatMoneyForDisplay } from '../money.ts';
import { html } from '../web/html.ts';
import { renderTestAlertPage } from '../web/pages.ts';
import { sendHtml } from './donation-routes.ts';

/** Rows in the on-stream table of biggest donations. */
const boardSize = 10;

/** How often the on-stream table re-reads its data. New donations are rare; this is plenty. */
const boardRefreshMs = 15_000;

/** Pending alerts older than this are not replayed, so a long-closed OBS does not flood the stream. */
export const alertReplayWindowMs = 24 * 60 * 60 * 1000;

/**
 * Comment line sent periodically on the event stream. Cloudflare and most
 * proxies close a response that is silent for about 100 seconds.
 */
const heartbeatIntervalMs = 15_000;

export type OverlayRouteDependencies = {
  readonly config: Config;
  readonly donations: DonationRepository;
  readonly alertHub: AlertHub;
  /** Applies the streamer's filters; the only way alerts are built. */
  readonly presentAlert: AlertPresenter;
  /** Prepares speech and fans the alert out; used for test alerts. */
  readonly publishAlert: (presented: PresentedAlert) => void;
  /** Starts speech for an alert published before this process started (a replay). */
  readonly prepareSpeech: (presented: PresentedAlert) => void;
  /** Present only when text-to-speech is configured. */
  readonly alertSpeech?: AlertSpeech;
  /** Read-only queries behind the on-stream table of biggest donations. */
  readonly leaderboard: LeaderboardQueries;
  /** Injected for tests. */
  readonly now?: () => Date;
};

/** The overlay runs a script, so it needs a looser policy than the script-free public pages. */
const overlayContentSecurityPolicy =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; media-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

type TokenParams = { token: string };

export function registerOverlayRoutes(app: FastifyInstance, dependencies: OverlayRouteDependencies): void {
  const { config, donations, alertHub, presentAlert, publishAlert, prepareSpeech, alertSpeech, leaderboard } =
    dependencies;
  const bannedWords = createBannedWordFilter(config.filters.bannedWords);
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

  app.get<{ Params: TokenParams }>('/overlay/:token/board', async (request, reply) => {
    reply.header('content-security-policy', overlayContentSecurityPolicy);
    const page = html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Biggest donations</title>
    <link rel="stylesheet" href="/static/board.css">
    <script src="/static/board.js" type="module"></script>
  </head>
  <!-- Relative to /overlay/<token>/board, so the token is never written into the page. -->
  <body data-data-url="board.json" data-refresh-ms="${boardRefreshMs}">
    <section class="board-panel" aria-label="Biggest donations">
      <h1 class="board-panel__title">Top donations</h1>
      <ol class="board-list" id="board-list"></ol>
      <p class="board-panel__empty" id="board-empty" hidden>No donations yet</p>
    </section>
  </body>
</html>`;
    return sendHtml(reply, 200, page);
  });

  app.get<{ Params: TokenParams }>('/overlay/:token/board.json', async (_request, reply) => {
    const currency = config.donation.currency;
    const rows = leaderboard.biggest(currency, boardSize).map((row) => ({
      donorName: bannedWords.mask(row.donorName),
      amount: formatMoneyForDisplay(row.amountMinor, currency),
    }));
    return reply.header('cache-control', 'no-store').send({ donations: rows });
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
    <script src="/static/overlay.js" type="module"></script>
  </head>
  <body
    data-events-url="${request.params.token}/events"
    data-alert-duration-ms="${config.alert.durationMs}"
    data-text-template="${config.alert.textTemplate}"
    data-sound="${config.alert.sound.kind === 'file' ? `${request.params.token}/assets/sound` : config.alert.sound.kind}"
    data-image-url="${config.alert.imageFileName === null ? '' : `${request.params.token}/assets/image`}"
    data-speech="${alertSpeech === undefined || config.tts === null ? 'off' : 'on'}">
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

  app.get<{ Params: TokenParams & { id: string } }>('/overlay/:token/alerts/:id/speech', async (request, reply) => {
    if (alertSpeech === undefined || config.tts === null) return reply.callNotFound();
    const { id } = request.params;
    let audio = alertSpeech.getAudio(id);
    if (audio === undefined) {
      // Not prepared in this process: a replayed alert from before a restart, or
      // one that expired from the cache. Rebuilt from the stored donation.
      const donation = donations.findByPublicId(id);
      if (donation === undefined || donation.alertTriggeredAt === null) return reply.callNotFound();
      // Re-applies today's filters, so a donation now below TTS_MIN_AMOUNT stays silent.
      prepareSpeech(presentAlert(donationToAlertSource(donation)));
      audio = alertSpeech.getAudio(id);
      if (audio === undefined) return reply.callNotFound();
    }
    try {
      const wav = await audio;
      return reply.type('audio/wav').header('cache-control', 'no-store').send(wav);
    } catch {
      // Already logged where synthesis failed. The overlay shows the alert silently.
      return reply.code(503).send();
    }
  });

  // Fixed routes rather than serving the folder, so only the two configured files
  // are reachable and a file name can never be used to wander the disk.
  app.get<{ Params: TokenParams }>('/overlay/:token/assets/sound', async (_request, reply) => {
    const { sound } = config.alert;
    if (sound.kind !== 'file') return reply.callNotFound();
    return reply.sendFile(sound.fileName, config.alert.assetsDirectory);
  });

  app.get<{ Params: TokenParams }>('/overlay/:token/assets/image', async (_request, reply) => {
    if (config.alert.imageFileName === null) return reply.callNotFound();
    return reply.sendFile(config.alert.imageFileName, config.alert.assetsDirectory);
  });

  const defaultTestValues: DonationFormValues = {
    donorName: 'Test donor',
    amount: '5',
    message: 'This is a test alert. Nothing was charged.',
    // Test alerts are never stored, so the leaderboard choice does not apply.
    listed: false,
  };

  app.get<{ Params: TokenParams; Querystring: { sent?: string } }>('/overlay/:token/test', async (request, reply) => {
    const sentTo = Number(request.query.sent);
    const notice = Number.isInteger(sentTo) && sentTo >= 0 ? describeDelivery(sentTo) : undefined;
    return sendHtml(
      reply,
      200,
      renderTestAlertPage({
        currency: config.donation.currency,
        values: defaultTestValues,
        ...(notice !== undefined && { notice }),
      }),
    );
  });

  app.post<{ Params: TokenParams }>('/overlay/:token/test', async (request, reply) => {
    // Same normalisation and length limits as a real donation, so the test shows
    // exactly what a donor could put on screen. The amount range is not enforced:
    // a test may want to preview an amount outside the configured limits.
    const result = validateDonationForm(request.body, {
      currency: config.donation.currency,
      fractionDigits: config.donation.fractionDigits,
      minAmountMinor: 1,
      maxAmountMinor: Number.MAX_SAFE_INTEGER,
      messageMaxLength: config.filters.messageMaxLength,
    });
    if (!result.ok) {
      return sendHtml(
        reply,
        400,
        renderTestAlertPage({ currency: config.donation.currency, values: result.values, errors: result.errors }),
      );
    }
    // Never stored, so the "test-" id makes the overlay's acknowledgement a no-op.
    // Filtered like a real donation, so a test previews exactly what would show.
    publishAlert(
      presentAlert({
        id: `test-${randomUUID()}`,
        donorName: result.donation.donorName,
        message: result.donation.message,
        amountMinor: result.donation.amountMinor,
        currency: config.donation.currency,
      }),
    );
    request.log.info({ overlays: alertHub.subscriberCount }, 'Test alert sent');
    // Post/redirect/get, so refreshing the result does not send another alert.
    return reply.redirect(`test?sent=${alertHub.subscriberCount}`, 303);
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
      if (sentIds.has(alert.id) && alert.replay !== true) return;
      sentIds.add(alert.id);
      response.write(`id: ${alert.id}\nevent: alert\ndata: ${JSON.stringify(alert)}\n\n`);
    };

    // Subscribed before the backlog query, so an alert arriving in between is not
    // missed; `sentIds` stops it being sent twice.
    const unsubscribe = alertHub.subscribe(send);
    const unsubscribeSkips = alertHub.subscribeToSkips((alertId) => {
      response.write(`event: skip\ndata: ${JSON.stringify({ id: alertId })}\n\n`);
    });
    const replayCutoff = new Date(now().getTime() - alertReplayWindowMs).toISOString();
    for (const donation of donations.listPendingAlerts(replayCutoff)) {
      send(presentAlert(donationToAlertSource(donation)).alert);
    }

    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), heartbeatIntervalMs);
    request.log.info({ subscribers: alertHub.subscriberCount }, 'Overlay connected');

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeSkips();
      request.log.info({ subscribers: alertHub.subscriberCount }, 'Overlay disconnected');
    });
  }
}

function describeDelivery(overlayCount: number): string {
  if (overlayCount === 0) {
    return 'No overlay is connected, so nobody saw it. Check that the Browser Source in OBS uses this same URL without /test, and that it is visible in the current scene.';
  }
  return `Sent to ${overlayCount} overlay${overlayCount === 1 ? '' : 's'}.`;
}
