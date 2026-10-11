import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAlertHub, type OverlayAlert } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/database.ts';
import {
  createDonationRepository,
  type Donation,
  type DonationRepository,
} from '../src/donations/donation-repository.ts';

const ipnSecret = 'test-ipn-secret';

function sortObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const value = obj[key];
      result[key] = value && typeof value === 'object' ? sortObject(value as Record<string, unknown>) : value;
      return result;
    }, {});
}

function sign(payload: Record<string, unknown>, secret = ipnSecret): string {
  return createHmac('sha512', secret).update(JSON.stringify(sortObject(payload))).digest('hex');
}

describe('POST /webhooks/nowpayments', () => {
  let app: FastifyInstance;
  let donations: DonationRepository;
  let onDonationAlert: ReturnType<typeof vi.fn<(alert: OverlayAlert) => void>>;
  let donation: Donation;

  function buildWith(alertOnStatus: string, alertHandler: (alert: OverlayAlert) => void = () => {}) {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://dono.example.com',
      NOWPAYMENTS_API_KEY: 'k',
      OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
    NOWPAYMENTS_IPN_SECRET: ipnSecret,
      ALERT_ON_STATUS: alertOnStatus,
      LOG_LEVEL: 'fatal',
    });
    donations = createDonationRepository(openDatabase(':memory:'));
    onDonationAlert = vi.fn(alertHandler);
    // The hub swallows listener errors, so a throwing handler is wrapped to reach
    // the webhook's own guard through a hub that rethrows.
    const alertHub = createAlertHub((error) => {
      throw error;
    });
    alertHub.subscribe(onDonationAlert);
    app = buildApp(config, {
      donations,
      nowPayments: {
        createInvoice: vi.fn(async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/payment/?iid=1' })),
      },
      alertHub,
    });
    donation = donations.create({ donorName: 'Ann', message: 'gg', amountMinor: 500, currency: 'usd' });
    donations.setInvoiceId(donation.publicId, '5309742318');
  }

  function ipn(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      payment_id: 5077125051,
      parent_payment_id: null,
      invoice_id: 5309742318,
      payment_status: status,
      pay_address: 'ltc1qexample',
      price_amount: 5,
      price_currency: 'usd',
      pay_amount: 0.0712,
      actually_paid: 0.0712,
      actually_paid_at_fiat: 0,
      pay_currency: 'ltc',
      order_id: donation.publicId,
      order_description: 'Donation to Arash',
      purchase_id: '5000000001',
      outcome_amount: 0.0705,
      outcome_currency: 'ltc',
      payment_extra_ids: null,
      fee: { currency: 'ltc', depositFee: 0.0004, withdrawalFee: 0, serviceFee: 0.0003 },
      ...overrides,
    };
  }

  function post(payload: Record<string, unknown> | string, signature?: string) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: '/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined && { 'x-nowpayments-sig': signature }),
      },
      payload: body,
    });
  }

  beforeEach(() => buildWith('confirmed'));
  afterEach(async () => {
    await app.close();
  });

  it('records the payment and alerts once the threshold is reached', async () => {
    for (const status of ['waiting', 'confirming']) {
      const payload = ipn(status);
      expect((await post(payload, sign(payload))).statusCode).toBe(200);
    }
    expect(onDonationAlert).not.toHaveBeenCalled();

    const confirmed = ipn('confirmed');
    const response = await post(confirmed, sign(confirmed));
    expect(response.statusCode).toBe(200);
    expect(onDonationAlert).toHaveBeenCalledTimes(1);
    expect(onDonationAlert.mock.calls[0]?.[0]).toEqual({
      id: donation.publicId,
      donorName: 'Ann',
      message: 'gg',
      amount: '$5.00',
    });
    expect(donations.findByPublicId(donation.publicId)).toMatchObject({
      status: 'confirmed',
      payCurrency: 'ltc',
      actuallyPaid: '0.0712',
      nowpaymentsPaymentId: '5077125051',
    });
  });

  it('alerts only once across retries and later statuses', async () => {
    for (const status of ['confirmed', 'confirmed', 'sending', 'finished', 'finished']) {
      const payload = ipn(status);
      expect((await post(payload, sign(payload))).statusCode).toBe(200);
    }
    expect(onDonationAlert).toHaveBeenCalledTimes(1);
    expect(donations.findByPublicId(donation.publicId)?.status).toBe('finished');
  });

  it('alerts on confirming when configured to', async () => {
    await app.close();
    buildWith('confirming');
    const payload = ipn('confirming');
    await post(payload, sign(payload));
    expect(onDonationAlert).toHaveBeenCalledTimes(1);
  });

  it('rejects a request without a signature and changes nothing', async () => {
    const response = await post(ipn('finished'));
    expect(response.statusCode).toBe(401);
    expect(onDonationAlert).not.toHaveBeenCalled();
    expect(donations.findByPublicId(donation.publicId)?.status).toBe('created');
  });

  it('rejects a signature made with the wrong secret', async () => {
    const payload = ipn('finished');
    expect((await post(payload, sign(payload, 'attacker-guess'))).statusCode).toBe(401);
    expect(onDonationAlert).not.toHaveBeenCalled();
  });

  it('rejects a body altered after signing', async () => {
    const payload = ipn('waiting');
    const signature = sign(payload);
    expect((await post({ ...payload, payment_status: 'finished' }, signature)).statusCode).toBe(401);
    expect(onDonationAlert).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body', async () => {
    expect((await post('payment_status=finished', 'a'.repeat(128))).statusCode).toBe(401);
  });

  it('answers 400 to a signed payload missing required fields', async () => {
    const payload = { order_id: donation.publicId, payment_status: 'finished' };
    expect((await post(payload, sign(payload))).statusCode).toBe(400);
  });

  it.each([
    ['an unknown order id', { order_id: 'not-a-donation' }],
    ['no order id', { order_id: null }],
    ['an unrecognised status', { payment_status: 'teleported' }],
    ['a different invoice', { invoice_id: 999 }],
  ])('acknowledges but ignores an IPN with %s', async (_label, overrides) => {
    const payload = ipn('finished', overrides);
    expect((await post(payload, sign(payload))).statusCode).toBe(200);
    expect(onDonationAlert).not.toHaveBeenCalled();
    expect(donations.findByPublicId(donation.publicId)?.status).toBe('created');
  });

  it('ignores an outdated status arriving after a later one', async () => {
    const finished = ipn('finished');
    await post(finished, sign(finished));
    const late = ipn('confirming');
    expect((await post(late, sign(late))).statusCode).toBe(200);
    expect(donations.findByPublicId(donation.publicId)?.status).toBe('finished');
  });

  it('still answers 200 when delivering the alert throws, so NOWPayments does not retry', async () => {
    await app.close();
    buildWith('confirmed', () => {
      throw new Error('overlay offline');
    });
    const payload = ipn('confirmed');
    expect((await post(payload, sign(payload))).statusCode).toBe(200);
    expect(donations.findByPublicId(donation.publicId)?.alertTriggeredAt).not.toBeNull();
  });

  it('accepts string ids and string amounts', async () => {
    const payload = ipn('confirmed', { payment_id: '5077125051', invoice_id: '5309742318', actually_paid: '0.07120000' });
    expect((await post(payload, sign(payload))).statusCode).toBe(200);
    expect(donations.findByPublicId(donation.publicId)).toMatchObject({
      nowpaymentsPaymentId: '5077125051',
      actuallyPaid: '0.07120000',
    });
  });

  it('accepts a payload with arrays signed in either canonical form', async () => {
    const payload = ipn('confirmed', { payment_extra_ids: [5513339153] });
    expect((await post(payload, sign(payload))).statusCode).toBe(200);
    expect(onDonationAlert).toHaveBeenCalledTimes(1);
  });

  it('does not affect JSON parsing for other routes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/donate',
      headers: { 'content-type': 'application/json' },
      payload: '{"amount":"5"}',
    });
    // Parsed as an object, not left as a raw string, so the donation goes through.
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://nowpayments.io/payment/?iid=1');
  });
});
