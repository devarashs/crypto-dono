/**
 * HTTP application assembly.
 *
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` with no open port.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import type { DonationRepository } from './donations/donation-repository.ts';

/** Collaborators the routes need, injected so tests can supply their own. */
export type AppDependencies = {
  readonly donations: DonationRepository;
};

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
    trustProxy: true,
  });

  // Liveness probe for Docker's HEALTHCHECK and for uptime monitors.
  app.get('/healthz', async () => ({ status: 'ok' }));

  return app;
}
