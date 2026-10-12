import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

describe('soundboard routes', () => {
  let assetsDirectory: string;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    assetsDirectory = mkdtempSync(join(tmpdir(), 'crypto-dono-sounds-'));
    writeFileSync(join(assetsDirectory, 'airhorn.mp3'), 'fake mp3 bytes');
    writeFileSync(join(assetsDirectory, 'unlisted.mp3'), 'private');
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(assetsDirectory, { recursive: true, force: true });
  });

  function build(): FastifyInstance {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://dono.example.com',
      NOWPAYMENTS_API_KEY: 'k',
      NOWPAYMENTS_IPN_SECRET: 's',
      OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
      LOG_LEVEL: 'fatal',
      CUSTOM_ASSETS_DIR: assetsDirectory,
    });
    const store = createInMemoryStore();
    app = buildApp(config, {
      donations: store.donations,
      leaderboard: store.leaderboard,
      connections: store.connections,
      nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
      alertHub: createAlertHub(),
    });
    return app;
  }

  it('serves a listed sound by its id, for previews', async () => {
    writeFileSync(join(assetsDirectory, 'soundboard.json'), JSON.stringify([{ id: 'airhorn', name: 'Air horn', price: 2, file: 'airhorn.mp3' }]));
    const response = await build().inject({ method: 'GET', url: '/sounds/airhorn/audio' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.body).toBe('fake mp3 bytes');
  });

  it('serves nothing that is not listed', async () => {
    writeFileSync(join(assetsDirectory, 'soundboard.json'), JSON.stringify([{ id: 'airhorn', name: 'Air horn', price: 2, file: 'airhorn.mp3' }]));
    const server = build();
    for (const url of ['/sounds/unlisted/audio', '/sounds/unlisted.mp3/audio', '/sounds/..%2Fsoundboard.json/audio']) {
      expect((await server.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('has no soundboard routes without soundboard.json', async () => {
    expect((await build().inject({ method: 'GET', url: '/sounds/airhorn/audio' })).statusCode).toBe(404);
  });
});
