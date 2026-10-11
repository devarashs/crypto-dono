import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAlertHub, type AlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { createDonationRepository, type DonationRepository } from '../src/donations/donation-repository.ts';
import { createAlertSpeech } from '../src/tts/alert-speech.ts';

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
      expect(response.body).toContain('src="/static/overlay.js" type="module"');
      expect(response.body).toContain('data-alert-duration-ms="8000"');
      expect(response.body).toContain('data-text-template="{name} donated {amount}"');
      expect(response.body).toContain('data-sound="chime"');
      expect(response.body).toContain('data-image-url=""');
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
        ['alert-template.js', /javascript/],
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
      alertHub.publish({ id: 'live-1', donorName: 'Live', message: 'hi', amount: '$2.00', speak: false });
      await stream.waitFor('Live');
      expect(stream.text()).toContain('id: live-1\nevent: alert\n');
      expect(parseAlerts(stream.text())).toEqual([
        { id: 'live-1', donorName: 'Live', message: 'hi', amount: '$2.00', speak: false },
      ]);
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
      alertHub.publish({ id, donorName: 'Once', message: '', amount: '$5.00', speak: false });
      alertHub.publish({ id: 'next', donorName: 'Next', message: '', amount: '$1.00', speak: false });
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

  describe('custom alert assets', () => {
    let assetsDirectory: string;
    let customApp: FastifyInstance;

    beforeEach(() => {
      assetsDirectory = mkdtempSync(join(tmpdir(), 'crypto-dono-assets-'));
      writeFileSync(join(assetsDirectory, 'cash.mp3'), 'fake mp3 bytes');
      writeFileSync(join(assetsDirectory, 'party.gif'), 'GIF89a fake');
      writeFileSync(join(assetsDirectory, 'other.txt'), 'not configured');
    });
    afterEach(async () => {
      await customApp?.close();
      rmSync(assetsDirectory, { recursive: true, force: true });
    });

    function buildCustomApp(overrides: Record<string, string>) {
      const config = loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: token,
        LOG_LEVEL: 'fatal',
        CUSTOM_ASSETS_DIR: assetsDirectory,
        ...overrides,
      });
      customApp = buildApp(config, {
        donations: createDonationRepository(openDatabase(':memory:')),
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
      });
      return customApp;
    }

    it('passes the configured settings to the page and serves the two files', async () => {
      const custom = buildCustomApp({
        ALERT_SOUND: 'cash.mp3',
        ALERT_IMAGE: 'party.gif',
        ALERT_DURATION_SECONDS: '5',
        ALERT_TEXT_TEMPLATE: '<b>{name}</b> & {amount}',
      });
      const page = await custom.inject({ method: 'GET', url: `/overlay/${token}` });
      expect(page.body).toContain(`data-sound="${token}/assets/sound"`);
      expect(page.body).toContain(`data-image-url="${token}/assets/image"`);
      expect(page.body).toContain('data-alert-duration-ms="5000"');
      // Escaped into the attribute; the overlay later inserts it as text, never HTML.
      expect(page.body).toContain('data-text-template="&lt;b&gt;{name}&lt;/b&gt; &amp; {amount}"');

      const sound = await custom.inject({ method: 'GET', url: `/overlay/${token}/assets/sound` });
      expect(sound.statusCode).toBe(200);
      expect(sound.headers['content-type']).toBe('audio/mpeg');
      expect(sound.body).toBe('fake mp3 bytes');

      const image = await custom.inject({ method: 'GET', url: `/overlay/${token}/assets/image` });
      expect(image.statusCode).toBe(200);
      expect(image.headers['content-type']).toBe('image/gif');
    });

    it('marks the sound as none when silenced', async () => {
      const page = await buildCustomApp({ ALERT_SOUND: 'none' }).inject({ method: 'GET', url: `/overlay/${token}` });
      expect(page.body).toContain('data-sound="none"');
    });

    it('answers 404 for assets that are not configured', async () => {
      const custom = buildCustomApp({});
      for (const asset of ['sound', 'image']) {
        const response = await custom.inject({ method: 'GET', url: `/overlay/${token}/assets/${asset}` });
        expect(response.statusCode, asset).toBe(404);
      }
    });

    it('serves nothing else from the folder, and nothing without the token', async () => {
      const custom = buildCustomApp({ ALERT_SOUND: 'cash.mp3' });
      for (const url of [
        `/overlay/${token}/assets/other.txt`,
        `/overlay/${token}/assets/../assets/sound/../../other.txt`,
        '/overlay/wrong-token-wrong-token-wrong/assets/sound',
        '/custom/cash.mp3',
      ]) {
        const response = await custom.inject({ method: 'GET', url });
        expect(response.statusCode, url).toBe(404);
        expect(response.body).not.toContain('not configured');
      }
    });
  });

  describe('alert speech', () => {
    let speechApp: FastifyInstance;
    let synthesize: ReturnType<typeof vi.fn<(text: string) => Promise<Buffer>>>;
    let speechDonations: DonationRepository;

    function wav(label: string): Buffer {
      const bytes = Buffer.alloc(44 + label.length);
      bytes.write('RIFF', 0, 'ascii');
      bytes.write('WAVE', 8, 'ascii');
      bytes.write(label, 44, 'utf8');
      return bytes;
    }

    function buildSpeechApp(ttsUrl: string | undefined) {
      const config = loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: token,
        LOG_LEVEL: 'fatal',
        TTS_TEMPLATE: '{name} sent {amount}. {message}',
        ...(ttsUrl !== undefined && { TTS_URL: ttsUrl }),
      });
      speechDonations = createDonationRepository(openDatabase(':memory:'));
      synthesize = vi.fn(async (text: string) => wav(text));
      speechApp = buildApp(config, {
        donations: speechDonations,
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        alertSpeech: createAlertSpeech({ synthesize }),
      });
      return speechApp;
    }

    afterEach(async () => {
      await speechApp?.close();
    });

    it('turns speech on in the page only when TTS_URL is set', async () => {
      const off = await buildSpeechApp(undefined).inject({ method: 'GET', url: `/overlay/${token}` });
      expect(off.body).toContain('data-speech="off"');
      await speechApp.close();
      const on = await buildSpeechApp('http://piper:5000').inject({ method: 'GET', url: `/overlay/${token}` });
      expect(on.body).toContain('data-speech="on"');
    });

    it('synthesises a test alert as soon as it is sent, and serves it as WAV', async () => {
      const app = buildSpeechApp('http://piper:5000');
      await app.inject({
        method: 'POST',
        url: `/overlay/${token}/test`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ donorName: 'Ann', amount: '5', message: 'hi there' }).toString(),
      });
      expect(synthesize).toHaveBeenCalledWith('Ann sent $5.00. hi there');
    });

    it('serves speech for a paid donation, rebuilding it after a restart', async () => {
      const app = buildSpeechApp('http://piper:5000');
      const { publicId } = speechDonations.create({ donorName: 'Bo', message: '', amountMinor: 250, currency: 'usd' });
      speechDonations.applyPaymentUpdate(
        publicId,
        { status: 'finished', paymentId: 'p', invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
        'confirmed',
      );

      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/alerts/${publicId}/speech` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('audio/wav');
      expect(response.rawPayload.subarray(44).toString()).toBe('Bo sent $2.50.');
      await app.inject({ method: 'GET', url: `/overlay/${token}/alerts/${publicId}/speech` });
      expect(synthesize).toHaveBeenCalledOnce();
    });

    it('answers 404 for an unknown alert or an unpaid donation', async () => {
      const app = buildSpeechApp('http://piper:5000');
      const { publicId } = speechDonations.create({ donorName: 'Unpaid', message: '', amountMinor: 250, currency: 'usd' });
      for (const id of ['nope', publicId, 'test-gone-after-restart']) {
        const response = await app.inject({ method: 'GET', url: `/overlay/${token}/alerts/${id}/speech` });
        expect(response.statusCode, id).toBe(404);
      }
      expect(synthesize).not.toHaveBeenCalled();
    });

    it('answers 503 when Piper fails, so the overlay carries on silently', async () => {
      const app = buildSpeechApp('http://piper:5000');
      synthesize.mockRejectedValue(new Error('piper down'));
      const { publicId } = speechDonations.create({ donorName: 'Cy', message: '', amountMinor: 250, currency: 'usd' });
      speechDonations.applyPaymentUpdate(
        publicId,
        { status: 'finished', paymentId: 'p', invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
        'confirmed',
      );
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/alerts/${publicId}/speech` });
      expect(response.statusCode).toBe(503);
    });

    it('answers 404 when text-to-speech is off', async () => {
      const app = buildSpeechApp(undefined);
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/alerts/anything/speech` });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('test alerts', () => {
    function postTest(fields: Record<string, string>, tokenInPath = token) {
      return app.inject({
        method: 'POST',
        url: `/overlay/${tokenInPath}/test`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(fields).toString(),
      });
    }

    it('renders the form prefilled with defaults', async () => {
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/test` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('value="Test donor"');
      expect(response.body).toContain('Send test alert');
      expect(response.headers['content-security-policy']).toContain("script-src 'none'");
    });

    it('publishes to connected overlays without storing anything, then redirects with the count', async () => {
      const received: unknown[] = [];
      alertHub.subscribe((alert) => received.push(alert));
      alertHub.subscribe(() => {});

      const response = await postTest({ donorName: '  Tester  ', amount: '12.5', message: 'line\nbreak' });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe('test?sent=2');
      expect(received).toEqual([
        {
          id: expect.stringMatching(/^test-[0-9a-f-]{36}$/),
          donorName: 'Tester',
          message: 'line break',
          amount: '$12.50',
          speak: false,
        },
      ]);
      expect(donations.listPendingAlerts('1970-01-01T00:00:00.000Z')).toEqual([]);
    });

    it('allows amounts outside the donation limits', async () => {
      const received: unknown[] = [];
      alertHub.subscribe((alert) => received.push(alert));
      expect((await postTest({ donorName: 'Big', amount: '50000' })).statusCode).toBe(303);
      expect(received).toMatchObject([{ amount: '$50,000.00' }]);
    });

    it('re-renders with errors for an invalid amount and publishes nothing', async () => {
      const listener = vi.fn();
      alertHub.subscribe(listener);
      const response = await postTest({ donorName: 'X', amount: 'lots' });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('aria-invalid="true"');
      expect(listener).not.toHaveBeenCalled();
    });

    it.each([
      ['0', 'No overlay is connected'],
      ['1', 'Sent to 1 overlay.'],
      ['3', 'Sent to 3 overlays.'],
    ])('reports delivery to %s overlays', async (sent, text) => {
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/test?sent=${sent}` });
      expect(response.body).toContain(text);
    });

    it('ignores a malformed sent count', async () => {
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/test?sent=abc` });
      expect(response.body).not.toContain('role="status"');
    });

    it('refuses a wrong token for both the form and the send', async () => {
      const listener = vi.fn();
      alertHub.subscribe(listener);
      expect((await app.inject({ method: 'GET', url: '/overlay/wrong-token-wrong-token-wrong/test' })).statusCode).toBe(404);
      expect((await postTest({ donorName: 'X', amount: '5' }, 'wrong-token-wrong-token-wrong')).statusCode).toBe(404);
      expect(listener).not.toHaveBeenCalled();
    });

    it('acknowledging a test alert is a harmless no-op', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/overlay/${token}/alerts/test-00000000-0000-0000-0000-000000000000/shown`,
      });
      expect(response.statusCode).toBe(204);
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
