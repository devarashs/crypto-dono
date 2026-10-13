/**
 * Password-protected admin pages, enabled only when ADMIN_PASSWORD is set.
 *
 *   GET  /admin/login                     sign-in form
 *   POST /admin/login                     check the password, start a session
 *   POST /admin/logout                    end the session
 *   GET  /admin                           donation history (?before=<id>&all=1)
 *   POST /admin/donations/:id/replay      show a donation's alert again
 *   POST /admin/donations/:id/skip        drop a pending alert, also from live overlays
 *   GET  /admin/{twitch,kick}/connect     start linking a channel (redirects to the platform)
 *   GET  /admin/{twitch,kick}/callback    where the platform sends the streamer back
 *   POST /admin/{twitch,kick}/disconnect  unlink the channel and stop its alerts
 *
 * Sessions are @fastify/session's, kept in the database (admin/session-store.ts)
 * so restarts and deploys do not sign the admin out; they end after 14 days
 * without a visit (rolling: each admin request extends them). The
 * cookie is scoped to /admin and HttpOnly. Over HTTPS it is Secure and
 * SameSite=Strict; over plain HTTP (localhost) the library lowers it to
 * SameSite=Lax. Both keep the cookie off cross-site POST requests, and every
 * state-changing admin action is a POST, so another site cannot submit them.
 */
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isCorrectAdminPassword } from '../admin/admin-auth.ts';
import type { ConnectionStore } from '../platforms/connection-store.ts';
import type { TwitchApi } from '../twitch/twitch-api.ts';
import { connectTwitch, disconnectTwitch } from '../twitch/twitch-connection.ts';
import { createPkcePair, type KickApi } from '../kick/kick-api.ts';
import { connectKick, disconnectKick } from '../kick/kick-connection.ts';
import type { ConnectablePlatform } from '../platforms/connection-store.ts';
import type { HealthPlatform, SubscriptionHealth } from '../platforms/subscription-health.ts';
import { registerLiveDashboardRoutes, type LiveDashboardDependencies } from './live-dashboard-routes.ts';
import type { PlatformStatus } from '../web/admin-pages.ts';
import type { AlertHub } from '../alerts/alert-hub.ts';
import { donationToAlertSource, type AlertPresenter, type PresentedAlert } from '../alerts/alert-presenter.ts';
import type { Config } from '../config.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import { renderAdminDashboard, renderLoginPage } from '../web/admin-pages.ts';
import { sendHtml } from './donation-routes.ts';

declare module 'fastify' {
  interface Session {
    isAdmin?: boolean;
  }
}

export type AdminRouteDependencies = {
  readonly config: Config & { readonly adminPassword: string };
  readonly donations: DonationRepository;
  readonly alertHub: AlertHub;
  readonly presentAlert: AlertPresenter;
  readonly publishAlert: (presented: PresentedAlert) => void;
  /** Signs the session cookie; at least 32 characters. */
  readonly sessionSecret: string;
  /** Where sign-ins are kept; in memory when absent (tests). */
  readonly sessionStore?: fastifySession.SessionStore;
  readonly connections: ConnectionStore;
  /** Present when TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set. */
  readonly twitch?: {
    readonly api: TwitchApi;
    readonly eventSubSecret: string;
    /** Absolute URL of this server's EventSub webhook. */
    readonly callbackUrl: string;
  };
  /** Present when KICK_CLIENT_ID and KICK_CLIENT_SECRET are set. */
  readonly kick?: { readonly api: KickApi };
  /** The live dashboard's feed sources. */
  readonly dashboard: Omit<LiveDashboardDependencies, 'donations'>;
  /** The last subscription health check, shown with each connected platform. */
  readonly subscriptionHealth?: Pick<SubscriptionHealth, 'finding' | 'clear'>;
  readonly now?: () => number;
};

/** How long a Connect click stays valid while the streamer is on the platform's site. */
const oauthStateLifetimeMs = 10 * 60 * 1000;

/** Signed out after this long without a visit; each admin request restarts it. */
const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;
const donationsPerPage = 25;

/** Fixed messages, chosen by code, so nothing from the URL is echoed onto the page. */
const notices: Readonly<Record<string, string>> = {
  replayed: 'Alert sent to the overlay again.',
  skipped: 'Alert skipped. It will not be shown or replayed.',
  'not-found': 'That donation no longer exists.',
  'no-alert': 'That donation has not been paid, so it has no alert.',
  'twitch-connected': 'Twitch connected. Follows, subs, bits and raids will alert on stream.',
  'twitch-partial': 'Twitch connected, but some event types were refused. Check the server log, then reconnect.',
  'twitch-denied': 'Twitch access was not granted, so nothing changed.',
  'twitch-failed': 'Twitch could not be reached or refused the request. Check the server log and try again.',
  'twitch-expired': 'That Twitch sign-in took too long or was already used. Click Connect Twitch again.',
  'twitch-disconnected': 'Twitch disconnected. Its alerts have stopped.',
  'kick-connected': 'Kick connected. Follows, subs and Kicks will alert on stream.',
  'kick-partial': 'Kick connected, but some event types were refused. Check the server log, then reconnect.',
  'kick-denied': 'Kick access was not granted, so nothing changed.',
  'kick-failed': 'Kick could not be reached or refused the request. Check the server log and try again.',
  'kick-expired': 'That Kick sign-in took too long or was already used. Click Connect Kick again.',
  'kick-disconnected': 'Kick disconnected. Its alerts have stopped.',
};

export function registerAdminRoutes(app: FastifyInstance, dependencies: AdminRouteDependencies): void {
  const { config, donations, alertHub, presentAlert, publishAlert, connections, twitch, kick, subscriptionHealth } = dependencies;
  const now = dependencies.now ?? Date.now;
  const twitchRedirectUri = `${config.publicBaseUrl}/admin/twitch/callback`;
  const kickRedirectUri = `${config.publicBaseUrl}/admin/kick/callback`;

  /**
   * One-time values linking a "Connect Twitch" click to Twitch's redirect back.
   * In memory: one admin, and a restart only means clicking Connect again.
   */
  const pendingTwitchStates = new Map<string, number>();
  function takeTwitchState(state: string | undefined): boolean {
    for (const [key, expiresAt] of pendingTwitchStates) if (expiresAt < now()) pendingTwitchStates.delete(key);
    if (state === undefined || !pendingTwitchStates.has(state)) return false;
    pendingTwitchStates.delete(state);
    return true;
  }

  /**
   * Kick's sign-in uses PKCE: each Connect click gets a verifier that only this
   * server knows, kept with its state until Kick sends the streamer back.
   */
  const pendingKickStates = new Map<string, { expiresAt: number; codeVerifier: string }>();
  function takeKickVerifier(state: string | undefined): string | undefined {
    for (const [key, pending] of pendingKickStates) if (pending.expiresAt < now()) pendingKickStates.delete(key);
    if (state === undefined) return undefined;
    const pending = pendingKickStates.get(state);
    pendingKickStates.delete(state);
    return pending?.codeVerifier;
  }

  function platformStatus(platform: ConnectablePlatform & HealthPlatform, configured: boolean): PlatformStatus {
    if (!configured) return { state: 'not-configured' };
    const connection = connections.find(platform);
    if (connection === undefined) return { state: 'disconnected' };
    if (connection.status !== 'active') {
      return { state: 'revoked', login: connection.accountLogin, reason: connection.statusReason ?? 'unknown' };
    }
    const problem = subscriptionHealth?.finding(platform)?.problem ?? null;
    return { state: 'connected', login: connection.accountLogin, ...(problem !== null && { problem }) };
  }

  app.register(fastifyCookie);
  app.register(fastifySession, {
    secret: dependencies.sessionSecret,
    cookieName: 'crypto_dono_admin',
    ...(dependencies.sessionStore !== undefined && { store: dependencies.sessionStore }),
    // Saved, with a fresh expiry, on every admin response: the expiry slides.
    rolling: true,
    // No cookie at all until someone signs in.
    saveUninitialized: false,
    cookie: {
      path: '/admin',
      httpOnly: true,
      sameSite: 'strict',
      // Secure over HTTPS (the tunnel or a proxy), still usable on http://localhost,
      // where the library lowers SameSite to Lax (see the header comment).
      secure: 'auto',
      maxAge: sessionLifetimeMs,
    },
  });

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    if (request.session.isAdmin !== true) return reply.redirect('/admin/login', 303);
  }

  app.get('/admin/login', async (request, reply) => {
    if (request.session.isAdmin === true) return reply.redirect('/admin', 303);
    return sendHtml(reply, 200, renderLoginPage());
  });

  app.post(
    '/admin/login',
    // Slows password guessing to a crawl without bothering the one real user.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const password = typeof body?.password === 'string' ? body.password : '';
      if (!isCorrectAdminPassword(password, config.adminPassword)) {
        request.log.warn('Failed admin sign-in');
        return sendHtml(reply, 401, renderLoginPage({ error: 'That password is not right.' }));
      }
      // A fresh session id on sign-in, so an id planted before login is useless.
      await request.session.regenerate();
      request.session.isAdmin = true;
      request.log.info('Admin signed in');
      return reply.redirect('/admin', 303);
    },
  );

  app.post('/admin/logout', async (request, reply) => {
    await request.session.destroy();
    return reply.redirect('/admin/login', 303);
  });

  app.get<{ Querystring: { before?: string; all?: string; notice?: string } }>(
    '/admin',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const beforeId = Number(request.query.before);
      const showUnpaid = request.query.all === '1';
      const page = donations.listPage({
        paidOnly: !showUnpaid,
        limit: donationsPerPage,
        ...(Number.isSafeInteger(beforeId) && beforeId > 0 && { beforeId }),
      });
      const overlayPath = `/overlay/${config.overlayToken}`;
      const notice = request.query.notice === undefined ? undefined : notices[request.query.notice];
      return sendHtml(
        reply,
        200,
        renderAdminDashboard({
          donations: page.donations,
          nextBeforeId: page.nextBeforeId,
          showUnpaid,
          overlayUrl: `${config.publicBaseUrl}${overlayPath}`,
          boardUrl: `${config.publicBaseUrl}${overlayPath}/board`,
          chatUrl: `${config.publicBaseUrl}${overlayPath}/chat`,
          viewersUrl: `${config.publicBaseUrl}${overlayPath}/viewers`,
          sceneUrls: ['starting-soon?minutes=5', 'brb', 'ending-soon'].map(
            (scene) => `${config.publicBaseUrl}${overlayPath}/scene/${scene}`,
          ),
          testAlertUrl: `${overlayPath}/test`,
          twitch: platformStatus('twitch', twitch !== undefined),
          kick: platformStatus('kick', kick !== undefined),
          ...(notice !== undefined && { notice }),
        }),
      );
    },
  );

  if (twitch !== undefined) {
    const twitchDependencies = {
      api: twitch.api,
      connections,
      callbackUrl: twitch.callbackUrl,
      eventSubSecret: twitch.eventSubSecret,
    };

    app.get('/admin/twitch/connect', { preHandler: requireAdmin }, async (_request, reply) => {
      const state = randomBytes(24).toString('base64url');
      pendingTwitchStates.set(state, now() + oauthStateLifetimeMs);
      return reply.redirect(twitch.api.authorizeUrl(twitchRedirectUri, state), 303);
    });

    // No admin session check here: the session cookie is SameSite and is not
    // sent on the redirect back from twitch.tv. The single-use state, which only
    // an admin's Connect click can create, is what proves the request is ours.
    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/admin/twitch/callback',
      async (request, reply) => {
        if (!takeTwitchState(request.query.state)) return reply.redirect('/admin?notice=twitch-expired', 303);
        if (request.query.error !== undefined || request.query.code === undefined) {
          return reply.redirect('/admin?notice=twitch-denied', 303);
        }
        try {
          const result = await connectTwitch(twitchDependencies, request.query.code, twitchRedirectUri);
          request.log.info({ login: result.login, failedTypes: result.failedTypes }, 'Twitch connected');
          subscriptionHealth?.clear('twitch');
          const notice = result.failedTypes.length === 0 ? 'twitch-connected' : 'twitch-partial';
          return reply.redirect(`/admin?notice=${notice}`, 303);
        } catch (error) {
          request.log.error({ err: error }, 'Connecting Twitch failed');
          return reply.redirect('/admin?notice=twitch-failed', 303);
        }
      },
    );

    app.post('/admin/twitch/disconnect', { preHandler: requireAdmin }, async (request, reply) => {
      try {
        await disconnectTwitch(twitchDependencies);
        return reply.redirect('/admin?notice=twitch-disconnected', 303);
      } catch (error) {
        request.log.error({ err: error }, 'Disconnecting Twitch failed');
        return reply.redirect('/admin?notice=twitch-failed', 303);
      }
    });
  }

  if (kick !== undefined) {
    const kickDependencies = { api: kick.api, connections };

    app.get('/admin/kick/connect', { preHandler: requireAdmin }, async (_request, reply) => {
      const state = randomBytes(24).toString('base64url');
      const pkce = createPkcePair();
      pendingKickStates.set(state, { expiresAt: now() + oauthStateLifetimeMs, codeVerifier: pkce.verifier });
      return reply.redirect(kick.api.authorizeUrl(kickRedirectUri, state, pkce.challenge), 303);
    });

    // No admin session check, as for Twitch: the single-use state is the proof.
    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      '/admin/kick/callback',
      async (request, reply) => {
        const codeVerifier = takeKickVerifier(request.query.state);
        if (codeVerifier === undefined) return reply.redirect('/admin?notice=kick-expired', 303);
        if (request.query.error !== undefined || request.query.code === undefined) {
          return reply.redirect('/admin?notice=kick-denied', 303);
        }
        try {
          const result = await connectKick(kickDependencies, request.query.code, kickRedirectUri, codeVerifier);
          request.log.info({ login: result.login, failedEvents: result.failedEvents }, 'Kick connected');
          subscriptionHealth?.clear('kick');
          return reply.redirect(`/admin?notice=${result.failedEvents.length === 0 ? 'kick-connected' : 'kick-partial'}`, 303);
        } catch (error) {
          request.log.error({ err: error }, 'Connecting Kick failed');
          return reply.redirect('/admin?notice=kick-failed', 303);
        }
      },
    );

    app.post('/admin/kick/disconnect', { preHandler: requireAdmin }, async (request, reply) => {
      try {
        await disconnectKick(kickDependencies);
        return reply.redirect('/admin?notice=kick-disconnected', 303);
      } catch (error) {
        request.log.error({ err: error }, 'Disconnecting Kick failed');
        return reply.redirect('/admin?notice=kick-failed', 303);
      }
    });
  }

  registerLiveDashboardRoutes(app, { ...dependencies.dashboard, donations }, requireAdmin);

  app.post<{ Params: { id: string } }>(
    '/admin/donations/:id/replay',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const donation = donations.findByPublicId(request.params.id);
      if (donation === undefined) return reply.redirect('/admin?notice=not-found', 303);
      if (donation.alertTriggeredAt === null) return reply.redirect('/admin?notice=no-alert', 303);
      // Current filters apply, so a word banned since then is masked in the replay too.
      const presented = presentAlert(donationToAlertSource(donation));
      publishAlert({ ...presented, alert: { ...presented.alert, replay: true } });
      return reply.redirect('/admin?notice=replayed', 303);
    },
  );

  app.post<{ Params: { id: string } }>('/admin/donations/:id/skip', { preHandler: requireAdmin }, async (request, reply) => {
    const donation = donations.findByPublicId(request.params.id);
    if (donation === undefined) return reply.redirect('/admin?notice=not-found', 303);
    // Marked shown so it is not replayed, and dropped from any overlay showing it now.
    donations.markAlertShown(donation.publicId);
    alertHub.skip(donation.publicId);
    return reply.redirect('/admin?notice=skipped', 303);
  });
}
