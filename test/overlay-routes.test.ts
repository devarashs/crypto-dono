import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAlertHub, type AlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { createDonationRepository, type DonationRepository } from '../src/donations/donation-repository.ts';

const token = 'overlay-token-for-tests-0123456789';

describe('overlay routes', () => {
  let app: FastifyInstance;
  let donations: DonationRepository;
  let alertHub: AlertHub;
  let openStreams: IncomingMessage[];

  beforeEach(() => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://dono.example.com',
      NOWPAYMENTS_API_KEY: 'k',
      NOWPAYMENTS_IPN_SECRET: 's',
      OVERLAY_TOKEN: token,
      LOG_LEVEL: 'fatal',
    });
    donations = createDonationRepository(openDatabase(':memory:'));
    alertHub = createAlertHub();
    app = buildApp(config, {
      donations,
      nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
      alertHub,
    });
    openStreams = [];
  });

  afterEach(async () => {
    for (const stream of openStreams) stream.destroy();
    await app.close();
  });

  function paidDonation(donorName: string, message = ''): string {
    const { publicId } = donations.create({ donorName, message, amountMinor: 500, currency: 'usd' });
    donations.applyPaymentUpdate(
      publicId,
      { status: 'finished', paymentId: `p-${donorName}`, invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
      'confirmed',
    );
    return publicId;
  }

  /** Opens the event stream on a real socket and collects what arrives. */
  async function openEventStream(path = `/overlay/${token}/events`) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path }, resolve).on('error', reject).end();
    });
    openStreams.push(response);
    let received = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      received += chunk;
    });
    return {
      response,
      text: () => received,
      async waitFor(fragment: string, timeoutMs = 2000) {
        const deadline = Date.now() + timeoutMs;
        while (!received.includes(fragment)) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${fragment}; got:\n${received}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  }

  function parseAlerts(streamText: string) {
    return streamText
      .split('\n\n')
      .filter((block) => block.includes('event: alert'))
      .map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));
  }

  describe('GET /overlay/:token', () => {
    it('serves the overlay page with a policy that allows its own script', async () => {
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('src="/static/overlay.js"');
      expect(response.body).toContain(`data-events-url="${token}/events"`);
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
      expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    it('keeps the script-free policy on the public pages', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.headers['content-security-policy']).toContain("script-src 'none'");
    });

    it.each([
      'wrong-token-wrong-token-wrong',
      `${token}x`,
      token.slice(0, -1),
      token.toUpperCase(),
    ])('answers 404 for token %j on every overlay route', async (wrongToken) => {
      for (const [method, url] of [
        ['GET', `/overlay/${wrongToken}`],
        ['GET', `/overlay/${wrongToken}/events`],
        ['POST', `/overlay/${wrongToken}/alerts/abc/shown`],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    });

    it('serves the overlay script and stylesheet', async () => {
      for (const [file, type] of [
        ['overlay.js', /javascript/],
        ['overlay.css', /text\/css/],
        ['tokens.css', /text\/css/],
      ] as const) {
        const response = await app.inject({ method: 'GET', url: `/static/${file}` });
        expect(response.statusCode, file).toBe(200);
        expect(response.headers['content-type']).toMatch(type);
      }
    });
  });

  describe('GET /overlay/:token/events', () => {
    it('opens an event stream that replays pending alerts oldest first', async () => {
      paidDonation('First', 'hello');
      paidDonation('Second');
      const stream = await openEventStream();
      expect(stream.response.statusCode).toBe(200);
      expect(stream.response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      await stream.waitFor('Second');
      expect(stream.text().startsWith('retry: 3000\n\n')).toBe(true);
      expect(parseAlerts(stream.text())).toMatchObject([
        { donorName: 'First', message: 'hello', amount: '$5.00' },
        { donorName: 'Second', message: '', amount: '$5.00' },
      ]);
    });

    it('pushes alerts published while connected', async () => {
      const stream = await openEventStream();
      await stream.waitFor('retry:');
      alertHub.publish({ id: 'live-1', donorName: 'Live', message: 'hi', amount: '$2.00' });
      await stream.waitFor('Live');
      expect(stream.text()).toContain('id: live-1\nevent: alert\n');
      expect(parseAlerts(stream.text())).toEqual([{ id: 'live-1', donorName: 'Live', message: 'hi', amount: '$2.00' }]);
    });

    it('does not replay alerts already shown', async () => {
      const shown = paidDonation('Shown');
      donations.markAlertShown(shown);
      paidDonation('Pending');
      const stream = await openEventStream();
      await stream.waitFor('Pending');
      expect(stream.text()).not.toContain('Shown');
    });

    it('does not send the same alert twice on one connection', async () => {
      const id = paidDonation('Once');
      const stream = await openEventStream();
      await stream.waitFor('Once');
      alertHub.publish({ id, donorName: 'Once', message: '', amount: '$5.00' });
      alertHub.publish({ id: 'next', donorName: 'Next', message: '', amount: '$1.00' });
      await stream.waitFor('Next');
      expect(parseAlerts(stream.text()).map((alert) => alert.donorName)).toEqual(['Once', 'Next']);
    });

    it('lets the server shut down while an overlay is connected', async () => {
      const stream = await openEventStream();
      await stream.waitFor('retry:');
      const closed = app.close().then(() => 'closed');
      const timedOut = new Promise((resolve) => setTimeout(() => resolve('still open after 2 s'), 2000));
      expect(await Promise.race([closed, timedOut])).toBe('closed');
    });

    it('unsubscribes when the overlay disconnects', async () => {
      const stream = await openEventStream();
      await stream.waitFor('retry:');
      expect(alertHub.subscriberCount).toBe(1);
      stream.response.destroy();
      const deadline = Date.now() + 2000;
      while (alertHub.subscriberCount !== 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(alertHub.subscriberCount).toBe(0);
    });
  });

  describe('POST /overlay/:token/alerts/:id/shown', () => {
    it('marks the alert shown, and is safe to repeat', async () => {
      const id = paidDonation('Ann');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({ method: 'POST', url: `/overlay/${token}/alerts/${id}/shown` });
        expect(response.statusCode).toBe(204);
      }
      expect(donations.findByPublicId(id)?.alertShownAt).not.toBeNull();
    });

    it('accepts an unknown id without error', async () => {
      const response = await app.inject({ method: 'POST', url: `/overlay/${token}/alerts/unknown/shown` });
      expect(response.statusCode).toBe(204);
    });
  });
});
