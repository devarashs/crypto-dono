import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { createDonationRepository } from '../src/donations/donation-repository.ts';

function buildTestApp(): FastifyInstance {
  const config = loadConfig({ PUBLIC_BASE_URL: 'https://dono.example.com', LOG_LEVEL: 'error' });
  return buildApp(config, { donations: createDonationRepository(openDatabase(':memory:')) });
}

describe('buildApp', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it('answers the health check', async () => {
    app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});
