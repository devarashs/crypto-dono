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
import type { Config } from './config.ts';
import type { DonationRepository } from './donations/donation-repository.ts';
import type { NowPaymentsClient } from './nowpayments/nowpayments-client.ts';
import { registerDonationRoutes, sendHtml } from './routes/donation-routes.ts';
import { renderErrorPage } from './web/pages.ts';

/** Collaborators the routes need, injected so tests can supply their own. */
export type AppDependencies = {
  readonly donations: DonationRepository;
  readonly nowPayments: NowPaymentsClient;
};

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Applied to every response. The pages load nothing from other origins and use no
 * inline script or style, so the policy can be strict.
 *
 * form-action must include NOWPayments: browsers apply it to the redirect that
 * follows a form submission, and POST /donate redirects to their checkout.
 */
const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; " +
    "form-action 'self' https://nowpayments.io https://*.nowpayments.io; frame-ancestors 'none'; base-uri 'none'",
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
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.headers(securityHeaders);
  });

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

  // Liveness probe for Docker's HEALTHCHECK and for uptime monitors.
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.register(async (scope) => {
    registerDonationRoutes(scope, { config, ...dependencies });
  });

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
