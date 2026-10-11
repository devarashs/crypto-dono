import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import { createDonationRepository, type DonationRepository } from '../src/donations/donation-repository.ts';
import {
  NowPaymentsApiError,
  type CreateInvoiceRequest,
  type NowPaymentsClient,
} from '../src/nowpayments/nowpayments-client.ts';

const checkoutUrl = 'https://nowpayments.io/payment/?iid=555';

type TestContext = {
  app: FastifyInstance;
  donations: DonationRepository;
  createInvoice: ReturnType<typeof vi.fn<NowPaymentsClient['createInvoice']>>;
};

function buildTestApp(
  environment: Record<string, string> = {},
  createInvoiceImplementation: NowPaymentsClient['createInvoice'] = async () => ({
    invoiceId: '555',
    invoiceUrl: checkoutUrl,
  }),
): TestContext {
  const config = loadConfig({
    PUBLIC_BASE_URL: 'https://dono.example.com',
    NOWPAYMENTS_API_KEY: 'test-key',
    NOWPAYMENTS_IPN_SECRET: 'test-ipn-secret',
    LOG_LEVEL: 'fatal',
    STREAMER_NAME: 'Arash',
    ...environment,
  });
  const donations = createDonationRepository(openDatabase(':memory:'));
  const createInvoice = vi.fn<NowPaymentsClient['createInvoice']>(createInvoiceImplementation);
  return {
    app: buildApp(config, { donations, nowPayments: { createInvoice }, onDonationAlert: () => {} }),
    donations,
    createInvoice,
  };
}

function postDonation(app: FastifyInstance, fields: Record<string, string>, remoteAddress = '203.0.113.7') {
  return app.inject({
    method: 'POST',
    url: '/donate',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
    remoteAddress,
  });
}

describe('app', () => {
  let context: TestContext | undefined;
  afterEach(async () => {
    await context?.app.close();
    context = undefined;
  });

  it('answers the health check', async () => {
    context = buildTestApp();
    const response = await context.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('renders an HTML 404 for unknown routes', async () => {
    context = buildTestApp();
    const response = await context.app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.body).toContain('Page not found');
  });

  it('sends security headers on every response', async () => {
    context = buildTestApp();
    const response = await context.app.inject({ method: 'GET', url: '/' });
    expect(response.headers['content-security-policy']).toContain("script-src 'none'");
    // Regression: NOWPayments' checkout URL 301s through plain http before
    // returning to https; without this source the browser blocks the redirect
    // and the donor stays on the form.
    expect(response.headers['content-security-policy']).toMatch(
      /form-action 'self' [^;]*https:\/\/nowpayments\.io[^;]*http:\/\/nowpayments\.io/,
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('serves the stylesheet', async () => {
    context = buildTestApp();
    const response = await context.app.inject({ method: 'GET', url: '/static/styles.css' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/css/);
  });

  describe('GET /', () => {
    it('renders the donation form with the streamer name and minimum', async () => {
      context = buildTestApp({ DONATION_MIN_AMOUNT: '2.50' });
      const response = await context.app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Support Arash');
      expect(response.body).toContain('Minimum $2.50');
      expect(response.body).toContain('action="/donate"');
    });

    it('uses a generic heading without a streamer name', async () => {
      context = buildTestApp({ STREAMER_NAME: '' });
      const response = await context.app.inject({ method: 'GET', url: '/' });
      expect(response.body).toContain('Support the stream');
    });

    it('shows a notice after a cancelled payment', async () => {
      context = buildTestApp();
      const response = await context.app.inject({ method: 'GET', url: '/?cancelled=1' });
      expect(response.body).toContain("didn&#39;t go through");
    });
  });

  describe('POST /donate', () => {
    it('stores the donation, creates an invoice and redirects to checkout', async () => {
      context = buildTestApp();
      const response = await postDonation(context.app, { donorName: 'Ann', amount: '5.50', message: 'gg' });

      expect(response.statusCode).toBe(303);
      expect(response.headers.location).toBe(checkoutUrl);

      const request = context.createInvoice.mock.calls[0]?.[0] as CreateInvoiceRequest;
      expect(request).toMatchObject({
        priceAmount: '5.50',
        priceCurrency: 'usd',
        orderDescription: 'Donation to Arash',
        ipnCallbackUrl: 'https://dono.example.com/webhooks/nowpayments',
        cancelUrl: 'https://dono.example.com/?cancelled=1',
      });
      expect(request.successUrl).toBe(`https://dono.example.com/thanks?donation=${request.orderId}`);

      expect(context.donations.findByPublicId(request.orderId)).toMatchObject({
        donorName: 'Ann',
        message: 'gg',
        amountMinor: 550,
        currency: 'usd',
        status: 'created',
        nowpaymentsInvoiceId: '555',
      });
    });

    it('re-renders the form with errors and escaped values when invalid', async () => {
      context = buildTestApp();
      const response = await postDonation(context.app, {
        donorName: '<script>x</script>',
        amount: '0.5',
        message: '',
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('The minimum is $1.00.');
      expect(response.body).toContain('aria-invalid="true"');
      expect(response.body).toContain('value="&lt;script&gt;x&lt;/script&gt;"');
      expect(response.body).not.toContain('<script>x</script>');
      expect(context.createInvoice).not.toHaveBeenCalled();
    });

    it('keeps the donation and shows a friendly page when NOWPayments fails', async () => {
      context = buildTestApp({}, async () => {
        throw new NowPaymentsApiError(500, 'upstream broke');
      });
      const response = await postDonation(context.app, { amount: '5' });
      expect(response.statusCode).toBe(502);
      expect(response.body).toContain('nothing was charged');
      expect(response.body).not.toContain('upstream broke');

      const orderId = (context.createInvoice.mock.calls[0]?.[0] as CreateInvoiceRequest).orderId;
      expect(context.donations.findByPublicId(orderId)).toMatchObject({
        status: 'created',
        nowpaymentsInvoiceId: null,
      });
    });

    it('rate-limits a single client after 10 submissions a minute', async () => {
      context = buildTestApp();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await postDonation(context.app, { amount: '5' })).statusCode).toBe(303);
      }
      const limited = await postDonation(context.app, { amount: '5' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['content-type']).toMatch(/^text\/html/);
      expect(limited.body).toContain('Too many attempts');
      // Another client is unaffected.
      expect((await postDonation(context.app, { amount: '5' }, '198.51.100.1')).statusCode).toBe(303);
    });

    it('rejects an oversized body with an HTML error page', async () => {
      context = buildTestApp();
      const response = await postDonation(context.app, { amount: '5', message: 'x'.repeat(20_000) });
      expect(response.statusCode).toBe(413);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(context.createInvoice).not.toHaveBeenCalled();
    });

    it('rejects a JSON body as invalid rather than crashing', async () => {
      context = buildTestApp();
      const response = await context.app.inject({
        method: 'POST',
        url: '/donate',
        headers: { 'content-type': 'application/json' },
        payload: '{"amount": 5}',
      });
      // A numeric amount is not a string from the form, so it is treated as missing.
      expect(response.statusCode).toBe(400);
      expect(context.createInvoice).not.toHaveBeenCalled();
    });
  });

  describe('GET /thanks', () => {
    it('thanks the donor by name with the amount', async () => {
      context = buildTestApp();
      const donation = context.donations.create({ donorName: 'Ann', message: '', amountMinor: 550, currency: 'usd' });
      const response = await context.app.inject({ method: 'GET', url: `/thanks?donation=${donation.publicId}` });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Thank you, Ann!');
      expect(response.body).toContain('$5.50');
    });

    it('shows a generic thank-you for an unknown or missing id', async () => {
      context = buildTestApp();
      for (const url of ['/thanks', '/thanks?donation=unknown']) {
        const response = await context.app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('Thank you!');
      }
    });
  });
});
