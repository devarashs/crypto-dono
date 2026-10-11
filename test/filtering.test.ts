/**
 * End-to-end checks that message filters apply on every path an alert can take:
 * a live payment webhook, a replay to a reconnecting overlay, a test alert, and
 * speech rebuilt after a restart.
 */
import { createHmac } from 'node:crypto';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { createDonationRepository, type DonationRepository } from '../src/donations/donation-repository.ts';
import { createAlertSpeech } from '../src/tts/alert-speech.ts';

const token = 'overlay-token-for-tests-0123456789';
const ipnSecret = 'ipn-secret';

function sortObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const value = obj[key];
      result[key] = value && typeof value === 'object' ? sortObject(value as Record<string, unknown>) : value;
      return result;
    }, {});
}

describe('message filters, end to end', () => {
  let app: FastifyInstance;
  let donations: DonationRepository;
  let published: OverlayAlert[];
  let synthesize: ReturnType<typeof vi.fn<(text: string) => Promise<Buffer>>>;

  beforeEach(() => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://dono.example.com',
      NOWPAYMENTS_API_KEY: 'k',
      NOWPAYMENTS_IPN_SECRET: ipnSecret,
      OVERLAY_TOKEN: token,
      LOG_LEVEL: 'fatal',
      TTS_URL: 'http://piper:5000',
      BANNED_WORDS: 'darn,heck',
      MESSAGE_MIN_AMOUNT: '3',
      TTS_MIN_AMOUNT: '5',
      MESSAGE_MAX_LENGTH: '40',
    });
    donations = createDonationRepository(openDatabase(':memory:'));
    const alertHub = createAlertHub();
    published = [];
    alertHub.subscribe((alert) => published.push(alert));
    synthesize = vi.fn(async (text: string) => {
      const wav = Buffer.alloc(44 + Buffer.byteLength(text));
      wav.write('RIFF', 0, 'ascii');
      wav.write('WAVE', 8, 'ascii');
      wav.write(text, 44);
      return wav;
    });
    app = buildApp(config, {
      donations,
      nowPayments: { createInvoice: async () => ({ invoiceId: 'inv', invoiceUrl: 'https://nowpayments.io/x' }) },
      alertHub,
      alertSpeech: createAlertSpeech({ synthesize }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function storedDonation(donorName: string, message: string, amountMinor: number): string {
    return donations.create({ donorName, message, amountMinor, currency: 'usd' }).publicId;
  }

  async function payViaWebhook(publicId: string) {
    const payload = { payment_id: 1, payment_status: 'finished', order_id: publicId, invoice_id: null };
    const signature = createHmac('sha512', ipnSecret).update(JSON.stringify(sortObject(payload))).digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/nowpayments',
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': signature },
      payload: JSON.stringify(payload),
    });
    expect(response.statusCode).toBe(200);
  }

  it('masks a live alert, and speaks it without the banned word', async () => {
    const id = storedDonation('Darn Dan', 'well heck, great stream', 1000);
    await payViaWebhook(id);
    expect(published).toEqual([
      { id, donorName: '**** Dan', message: 'well ****, great stream', amount: '$10.00', speak: true },
    ]);
    expect(synthesize).toHaveBeenCalledWith('Dan donated $10.00. well , great stream');
    // The donor's original words are kept for the streamer.
    expect(donations.findByPublicId(id)).toMatchObject({ donorName: 'Darn Dan', message: 'well heck, great stream' });
  });

  it('hides the message below MESSAGE_MIN_AMOUNT and stays silent below TTS_MIN_AMOUNT', async () => {
    const small = storedDonation('Sam', 'hidden text', 200);
    const medium = storedDonation('Mia', 'visible text', 400);
    await payViaWebhook(small);
    await payViaWebhook(medium);
    expect(published).toEqual([
      { id: small, donorName: 'Sam', message: '', amount: '$2.00', speak: false },
      { id: medium, donorName: 'Mia', message: 'visible text', amount: '$4.00', speak: false },
    ]);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('refuses speech for a stored donation below TTS_MIN_AMOUNT, even after a restart', async () => {
    const id = storedDonation('Mia', 'hello', 400);
    donations.applyPaymentUpdate(
      id,
      { status: 'finished', paymentId: 'p', invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
      'confirmed',
    );
    const response = await app.inject({ method: 'GET', url: `/overlay/${token}/alerts/${id}/speech` });
    expect(response.statusCode).toBe(404);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('masks an alert replayed to a reconnecting overlay', async () => {
    const id = storedDonation('Ann', 'darn good', 1000);
    donations.applyPaymentUpdate(
      id,
      { status: 'finished', paymentId: 'p', invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
      'confirmed',
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const streamText = await new Promise<string>((resolve, reject) => {
      httpGet({ host: '127.0.0.1', port, path: `/overlay/${token}/events` }, (response) => {
        let received = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          received += chunk;
          if (received.includes('event: alert')) {
            response.destroy();
            resolve(received);
          }
        });
      }).on('error', reject);
    });
    expect(streamText).toContain('"message":"**** good"');
    expect(streamText).not.toContain('darn');
  });

  it('filters a test alert the same way as a real one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/overlay/${token}/test`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ donorName: 'heck', amount: '2', message: 'not shown' }).toString(),
    });
    expect(response.statusCode).toBe(303);
    expect(published).toMatchObject([{ donorName: '****', message: '', amount: '$2.00', speak: false }]);
  });

  it('enforces MESSAGE_MAX_LENGTH on the donation form and says so up front', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.body).toContain('Up to 40 characters. Shown on stream for donations of $3.00 or more.');

    const response = await app.inject({
      method: 'POST',
      url: '/donate',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ amount: '5', message: 'x'.repeat(41) }).toString(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Keep your message to 40 characters or fewer.');
  });
});
