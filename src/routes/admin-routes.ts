/**
 * Password-protected admin pages, enabled only when ADMIN_PASSWORD is set.
 *
 *   GET  /admin/login                     sign-in form
 *   POST /admin/login                     check the password, start a session
 *   POST /admin/logout                    end the session
 *   GET  /admin                           donation history (?before=<id>&all=1)
 *   POST /admin/donations/:id/replay      show a donation's alert again
 *   POST /admin/donations/:id/skip        drop a pending alert, also from live overlays
 *
 * Sessions are @fastify/session's, kept in memory: a restart signs the admin
 * out, which is acceptable for one person and avoids a session store. The
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
import type { TwitchStatus } from '../web/admin-pages.ts';
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
  readonly connections: ConnectionStore;
  /** Present when TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set. */
  readonly twitch?: {
    readonly api: TwitchApi;
    readonly eventSubSecret: string;
    /** Absolute URL of this server's EventSub webhook. */
    readonly callbackUrl: string;
  };
  readonly now?: () => number;
};

/** How long a "Connect Twitch" click stays valid while the streamer is on twitch.tv. */
const oauthStateLifetimeMs = 10 * 60 * 1000;

const sessionLifetimeMs = 12 * 60 * 60 * 1000;
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
};

export function registerAdminRoutes(app: FastifyInstance, dependencies: AdminRouteDependencies): void {
  const { config, donations, alertHub, presentAlert, publishAlert, connections, twitch } = dependencies;
  const now = dependencies.now ?? Date.now;
  const twitchRedirectUri = `${config.publicBaseUrl}/admin/twitch/callback`;

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

  function twitchStatus(): TwitchStatus {
    if (twitch === undefined) return { state: 'not-configured' };
    const connection = connections.find('twitch');
    if (connection === undefined) return { state: 'disconnected' };
    return connection.status === 'active'
      ? { state: 'connected', login: connection.accountLogin }
      : { state: 'revoked', login: connection.accountLogin, reason: connection.statusReason ?? 'unknown' };
  }

  app.register(fastifyCookie);
  app.register(fastifySession, {
    secret: dependencies.sessionSecret,
    cookieName: 'crypto_dono_admin',
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
          sceneUrls: ['starting-soon?minutes=5', 'brb', 'ending-soon'].map(
            (scene) => `${config.publicBaseUrl}${overlayPath}/scene/${scene}`,
          ),
          testAlertUrl: `${overlayPath}/test`,
          twitch: twitchStatus(),
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
