/**
 * HTTP application assembly.
 *
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` with no open port.
 */
import { fileURLToPath } from 'node:url';
import formBody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AlertHub } from './alerts/alert-hub.ts';
import { randomUUID } from 'node:crypto';
import { createAlertPresenter, donationToAlertSource, type PresentedAlert } from './alerts/alert-presenter.ts';
import { createBannedWordFilter } from './alerts/banned-words.ts';
import { createEventPresenter } from './events/event-presenter.ts';
import type { StreamEvent } from './events/stream-event.ts';
import type { Config } from './config.ts';
import type { DonationRepository } from './donations/donation-repository.ts';
import type { LeaderboardQueries } from './donations/leaderboard.ts';
import type { ConnectionStore } from './platforms/connection-store.ts';
import { registerTwitchWebhookRoutes, twitchWebhookPath } from './routes/twitch-webhook-routes.ts';
import type { TwitchApi } from './twitch/twitch-api.ts';
import type { NowPaymentsClient } from './nowpayments/nowpayments-client.ts';
import { registerAdminRoutes } from './routes/admin-routes.ts';
import { registerDonationRoutes, sendHtml } from './routes/donation-routes.ts';
import { registerOverlayRoutes } from './routes/overlay-routes.ts';
import { registerSoundboardRoutes } from './routes/soundboard-routes.ts';
import { publicPagePolicy } from './web/content-security-policy.ts';
import { registerWebhookRoutes } from './routes/webhook-routes.ts';
import type { AlertSpeech } from './tts/alert-speech.ts';
import { renderErrorPage } from './web/pages.ts';

/** Collaborators the routes need, injected so tests can supply their own. */
export type AppDependencies = {
  readonly donations: DonationRepository;
  /** Read-only queries behind the public leaderboard. */
  readonly leaderboard: LeaderboardQueries;
  /** Which platform channels are linked (Twitch, ...), and webhook de-duplication. */
  readonly connections: ConnectionStore;
  /** Present when Twitch is configured: its API client and the EventSub signing secret. */
  readonly twitch?: { readonly api: TwitchApi; readonly eventSubSecret: string };
  readonly nowPayments: NowPaymentsClient;
  /** Receives each donation's alert once, and fans it out to connected overlays. */
  readonly alertHub: AlertHub;
  /** Speech for alerts; omitted when text-to-speech is not configured. */
  readonly alertSpeech?: AlertSpeech;
  /** Signs admin session cookies; required when ADMIN_PASSWORD is set. */
  readonly adminSessionSecret?: string;
};

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Self-hosted fonts, served straight from their npm packages so upgrades come
 * through npm and the licences ship alongside. Only these two files are served:
 * the rest of node_modules is never reachable.
 */
const fontFiles = new Map([
  ['orbitron-latin-wght-normal.woff2', '../node_modules/@fontsource-variable/orbitron/files/'],
  ['share-tech-mono-latin-400-normal.woff2', '../node_modules/@fontsource/share-tech-mono/files/'],
]);
const fontDirectories = [...new Set(fontFiles.values())].map((directory) =>
  fileURLToPath(new URL(directory, import.meta.url)),
);

/** Applied to every response; a route may set its own policy first. */
const securityHeaders = {
  'content-security-policy': publicPagePolicy,
  'x-content-type-options': 'nosniff',
  // The thanks URL carries the donation id; never leak it to another site.
  'referrer-policy': 'no-referrer',
} as const;

/**
 * @param config Validated configuration.
 * @param dependencies Collaborators shared by the routes.
 * @returns A Fastify instance with every route registered, not yet listening.
 */
export function buildApp(config: Config, dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Behind a tunnel or reverse proxy the client address arrives in
    // X-Forwarded-For; trusting it is what makes per-viewer rate limits work.
    // Exposed directly to the internet without a proxy, a client could spoof it
    // to dodge the limit, which is why the README recommends a proxy or tunnel.
    trustProxy: true,
    // Generous for a three-field form, small enough to refuse junk early.
    bodyLimit: 16 * 1024,
    // An overlay's event stream never ends by itself, so without this a shutdown
    // waits on it until Docker gives up and kills the process. The overlay
    // reconnects on its own once the service is back.
    forceCloseConnections: true,
  });

  app.addHook('onSend', async (_request, reply) => {
    // A route that needs a different policy (the overlay runs a script) sets its
    // own header, which this must not overwrite.
    const { 'content-security-policy': contentSecurityPolicy, ...otherHeaders } = securityHeaders;
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', contentSecurityPolicy);
    reply.headers(otherHeaders);
  });

  const presentAlert = createAlertPresenter({
    bannedWords: config.filters.bannedWords,
    messageMinAmountMinor: config.filters.messageMinAmountMinor,
    speechMinAmountMinor: config.filters.speechMinAmountMinor,
    // Speech only when both configured and wired up.
    speechTemplate: config.tts !== null && dependencies.alertSpeech !== undefined ? config.tts.template : null,
    soundboardPath: (soundId) =>
      config.soundboard?.some((sound) => sound.id === soundId) === true ? `/sounds/${encodeURIComponent(soundId)}/audio` : null,
  });

  /** Starts synthesising an alert's speech, if it is to be spoken. */
  function prepareSpeech(presented: PresentedAlert): void {
    if (presented.speechText === null || dependencies.alertSpeech === undefined) return;
    dependencies.alertSpeech.prepare(presented.alert.id, presented.speechText);
  }

  /** The one way alerts reach overlays, so every alert gets its speech prepared first. */
  const presentEvent = createEventPresenter(config.events, createBannedWordFilter(config.filters.bannedWords));

  /**
   * The one way platform events reach overlays.
   * @returns false when the streamer has switched this kind of event off.
   */
  function publishEvent(event: StreamEvent, alertId = `event-${randomUUID()}`): boolean {
    const alert = presentEvent(event, alertId);
    if (alert === null) return false;
    dependencies.alertHub.publish(alert);
    return true;
  }

  function publishAlert(presented: PresentedAlert): void {
    prepareSpeech(presented);
    dependencies.alertHub.publish(presented.alert);
  }

  app.register(formBody);
  app.register(rateLimit, {
    // Opt-in per route via `config.rateLimit`.
    global: false,
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      error: 'Too Many Requests',
      message: `Too many attempts. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });
  app.register(fastifyStatic, { root: publicDirectory, prefix: '/static/' });
  app.register(fastifyStatic, {
    root: fontDirectories,
    prefix: '/fonts/',
    // The first registration already added reply.sendFile.
    decorateReply: false,
    allowedPath: (pathName) => fontFiles.has(pathName.replace(/^\//, '')),
    // Font files never change under the same name within a release.
    maxAge: '7d',
  });

  // Liveness probe for Docker's HEALTHCHECK and for uptime monitors.
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.register(async (scope) => {
    registerDonationRoutes(scope, { config, ...dependencies });
  });
  app.register(async (scope) => {
    registerWebhookRoutes(scope, {
      config,
      donations: dependencies.donations,
      onDonationAlert: (donation) => publishAlert(presentAlert(donationToAlertSource(donation))),
    });
  });
  app.register(async (scope) => {
    registerOverlayRoutes(scope, {
      publishEvent,
      config,
      donations: dependencies.donations,
      alertHub: dependencies.alertHub,
      leaderboard: dependencies.leaderboard,
      presentAlert,
      publishAlert,
      prepareSpeech,
      ...(dependencies.alertSpeech !== undefined && { alertSpeech: dependencies.alertSpeech }),
    });
  });

  const twitch = config.twitch !== null ? dependencies.twitch : undefined;
  if (twitch !== undefined) {
    app.register(async (scope) => {
      registerTwitchWebhookRoutes(scope, {
        connections: dependencies.connections,
        eventSubSecret: twitch.eventSubSecret,
        publishEvent,
      });
    });
  }

  const { soundboard } = config;
  if (soundboard !== null) {
    app.register(async (scope) => {
      registerSoundboardRoutes(scope, { ...dependencies, config: { ...config, soundboard } });
    });
  }

  const { adminPassword } = config;
  if (adminPassword !== null) {
    if (dependencies.adminSessionSecret === undefined) {
      throw new Error('ADMIN_PASSWORD is set but no admin session secret was provided');
    }
    const sessionSecret = dependencies.adminSessionSecret;
    app.register(async (scope) => {
      registerAdminRoutes(scope, {
        config: { ...config, adminPassword },
        donations: dependencies.donations,
        alertHub: dependencies.alertHub,
        presentAlert,
        publishAlert,
        sessionSecret,
        connections: dependencies.connections,
        ...(twitch !== undefined && {
          twitch: { ...twitch, callbackUrl: `${config.publicBaseUrl}${twitchWebhookPath}` },
        }),
      });
    });
  }

  app.setNotFoundHandler((_request, reply) =>
    sendHtml(reply, 404, renderErrorPage('Page not found', 'There is nothing at this address.')),
  );

  // Visitors arrive from a form, so errors render as pages rather than JSON.
  app.setErrorHandler((error: { statusCode?: number; message?: string }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode === 429) {
      return sendHtml(reply, 429, renderErrorPage('Slow down a little', error.message ?? 'Too many attempts.'));
    }
    if (statusCode >= 400 && statusCode < 500) {
      request.log.info({ err: error }, 'Rejected request');
      return sendHtml(reply, statusCode, renderErrorPage('That request did not work', 'Please go back and try again.'));
    }
    request.log.error({ err: error }, 'Unhandled error');
    return sendHtml(reply, 500, renderErrorPage('Something went wrong', 'Please try again in a minute.'));
  });

  return app;
}
