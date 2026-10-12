import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { CreateInvoiceRequest } from '../src/nowpayments/nowpayments-client.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

describe('soundboard routes', () => {
  let assetsDirectory: string;
  let app: FastifyInstance | undefined;
  let store: ReturnType<typeof createInMemoryStore>;
  let invoices: CreateInvoiceRequest[];

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

  const listSounds = () =>
    writeFileSync(
      join(assetsDirectory, 'soundboard.json'),
      JSON.stringify([
        { id: 'airhorn', name: 'Air horn', price: '2.50', file: 'airhorn.mp3' },
        { id: 'bruh', name: 'Bruh <3', price: 1, file: 'airhorn.mp3' },
      ]),
    );
  const form = (fields: Record<string, string>) => ({
    method: 'POST' as const,
    url: '/sounds',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });

  function build(environment: Record<string, string> = {}): FastifyInstance {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://dono.example.com',
      NOWPAYMENTS_API_KEY: 'k',
      NOWPAYMENTS_IPN_SECRET: 's',
      OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
      LOG_LEVEL: 'fatal',
      CUSTOM_ASSETS_DIR: assetsDirectory,
      STREAMER_NAME: 'machinearash',
      ...environment,
    });
    store = createInMemoryStore();
    invoices = [];
    app = buildApp(config, {
      donations: store.donations,
      leaderboard: store.leaderboard,
      connections: store.connections,
      nowPayments: {
        createInvoice: async (request) => {
          invoices.push(request);
          return { invoiceId: 'inv-1', invoiceUrl: 'https://nowpayments.io/payment/?iid=inv-1' };
        },
      },
      alertHub: createAlertHub(),
    });
    return app;
  }

  it('serves a listed sound by its id, for previews', async () => {
    listSounds();
    const response = await build().inject({ method: 'GET', url: '/sounds/airhorn/audio' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.body).toBe('fake mp3 bytes');
  });

  it('serves nothing that is not listed', async () => {
    listSounds();
    const server = build();
    for (const url of ['/sounds/unlisted/audio', '/sounds/unlisted.mp3/audio', '/sounds/..%2Fsoundboard.json/audio']) {
      expect((await server.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('has no soundboard without soundboard.json', async () => {
    const server = build();
    for (const url of ['/sounds', '/sounds/airhorn/audio']) {
      expect((await server.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('lists each sound with its price and a preview, and offers the leaderboard choice', async () => {
    listSounds();
    const page = await build().inject({ method: 'GET', url: '/sounds' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('machinearash&#39;s soundboard');
    expect(page.body).toContain('value="airhorn"');
    expect(page.body).toContain('$2.50');
    expect(page.body).toContain('Bruh &lt;3');
    expect(page.body).toContain('src="/sounds/bruh/audio"');
    expect(page.body).toMatch(/name="listed"\s+checked/);
    expect(page.body).not.toContain('<script');
  });

  it('charges the listed price whatever the form says, and records the sound', async () => {
    listSounds();
    const response = await build().inject(form({ soundId: 'airhorn', donorName: 'NeonRider', listed: 'on', amount: '0.01' }));
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://nowpayments.io/payment/?iid=inv-1');
    expect(invoices).toEqual([
      expect.objectContaining({
        priceAmount: '2.50',
        priceCurrency: 'usd',
        orderDescription: 'Sound: Air horn',
        cancelUrl: 'https://dono.example.com/sounds?cancelled=1',
      }),
    ]);
    expect(store.donations.findByPublicId(invoices[0]!.orderId)).toMatchObject({
      donorName: 'NeonRider',
      message: '',
      amountMinor: 250,
      sound: { id: 'airhorn', name: 'Air horn' },
      showOnLeaderboard: true,
      nowpaymentsInvoiceId: 'inv-1',
    });
  });

  it('shows the form again, with what was chosen, when something is wrong', async () => {
    listSounds();
    const response = await build().inject(form({ soundId: 'airhorn', donorName: 'x'.repeat(40) }));
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Keep your name to 32 characters or fewer.');
    expect(response.body).toMatch(/value="airhorn"\s+checked/);
    expect(invoices).toEqual([]);
  });

  it('refuses a sound that is not listed', async () => {
    listSounds();
    const response = await build().inject(form({ soundId: 'unlisted' }));
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('That sound is no longer available.');
    expect(invoices).toEqual([]);
  });

  it('never lists the buyer while the leaderboard is off, and does not ask', async () => {
    listSounds();
    const server = build({ LEADERBOARD: 'off' });
    expect((await server.inject({ method: 'GET', url: '/sounds' })).body).not.toContain('name="listed"');
    await server.inject(form({ soundId: 'bruh', listed: 'on' }));
    expect(store.donations.findByPublicId(invoices[0]!.orderId)?.showOnLeaderboard).toBe(false);
  });

  it('thanks the buyer by sound, and says when a payment was cancelled', async () => {
    listSounds();
    const server = build();
    await server.inject(form({ soundId: 'airhorn' }));
    const thanks = await server.inject({ method: 'GET', url: `/thanks?donation=${invoices[0]!.orderId}` });
    expect(thanks.body).toContain('<strong>Air horn</strong> will play on stream');
    const cancelled = await server.inject({ method: 'GET', url: '/sounds?cancelled=1' });
    expect(cancelled.body).toContain('The payment didn&#39;t go through');
  });

  it('links to the soundboard from the donation page only when there is one', async () => {
    expect((await build().inject({ method: 'GET', url: '/' })).body).not.toContain('href="/sounds"');
    await app?.close();
    listSounds();
    expect((await build().inject({ method: 'GET', url: '/' })).body).toContain('href="/sounds"');
  });
});
