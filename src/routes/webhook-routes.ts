/**
 * NOWPayments IPN endpoint: POST /webhooks/nowpayments.
 *
 * Every response is deliberate about retries. NOWPayments resends a callback
 * that does not get a success response, so anything we will never be able to
 * act on (an unknown order, an outdated status) is answered 200 and logged,
 * while a bad signature is refused outright.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import {
  donationStatuses,
  type Donation,
  type DonationRepository,
  type DonationStatus,
} from '../donations/donation-repository.ts';
import { verifyIpnSignature } from '../nowpayments/ipn-signature.ts';
import { nowPaymentsWebhookPath } from './donation-routes.ts';

export type WebhookRouteDependencies = {
  readonly config: Config;
  readonly donations: DonationRepository;
  /** Called once per donation, when its payment first reaches the alert threshold. */
  readonly onDonationAlert: (donation: Donation) => void;
};

/** Ids arrive as numbers in some payloads and strings in others. */
const idSchema = z.union([z.number().int(), z.string().min(1)]).transform(String);
const optionalIdSchema = z
  .union([z.number().int(), z.string()])
  .nullish()
  .transform((value) => (value === null || value === undefined || value === '' ? null : String(value)));

// Only the fields this service uses; NOWPayments sends many more.
const ipnPayloadSchema = z.object({
  payment_id: idSchema,
  payment_status: z.string(),
  order_id: z.string().nullish(),
  invoice_id: optionalIdSchema,
  pay_currency: z.string().nullish(),
  // Display only, never computed with, so the number-to-string round trip is fine.
  actually_paid: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((value) => (value === null || value === undefined ? null : String(value))),
});

const knownStatuses = new Set<string>(donationStatuses);
const isPaymentStatus = (status: string): status is DonationStatus => knownStatuses.has(status) && status !== 'created';

export function registerWebhookRoutes(app: FastifyInstance, dependencies: WebhookRouteDependencies): void {
  const { config, donations, onDonationAlert } = dependencies;

  // The signature covers the body as NOWPayments serialised it, so the route
  // needs the raw text. Scoped to this plugin; other routes parse JSON normally.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body);
  });

  app.post(nowPaymentsWebhookPath, async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const signatureHeader = request.headers['x-nowpayments-sig'];
    const signatureVariant = verifyIpnSignature(
      rawBody,
      typeof signatureHeader === 'string' ? signatureHeader : undefined,
      config.nowPayments.ipnSecret,
    );
    if (signatureVariant === undefined) {
      // Nothing from the body is logged: it is unauthenticated input.
      request.log.warn('Rejected NOWPayments IPN with a missing or invalid signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const parsed = ipnPayloadSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) {
      request.log.error({ issues: parsed.error.issues }, 'Signed IPN did not have the expected shape');
      return reply.code(400).send({ error: 'unexpected payload' });
    }
    const payload = parsed.data;
    const logContext = {
      paymentId: payload.payment_id,
      invoiceId: payload.invoice_id,
      donationId: payload.order_id,
      status: payload.payment_status,
      signatureVariant,
    };

    if (!isPaymentStatus(payload.payment_status)) {
      request.log.warn(logContext, 'Ignoring IPN with an unrecognised payment status');
      return reply.code(200).send({ ok: true });
    }
    if (payload.order_id === null || payload.order_id === undefined || payload.order_id === '') {
      // Payments created outside this service, e.g. from the NOWPayments dashboard.
      request.log.info(logContext, 'Ignoring IPN without an order id');
      return reply.code(200).send({ ok: true });
    }

    const result = donations.applyPaymentUpdate(
      payload.order_id,
      {
        status: payload.payment_status,
        paymentId: payload.payment_id,
        invoiceId: payload.invoice_id,
        payCurrency: payload.pay_currency ?? null,
        actuallyPaid: payload.actually_paid,
      },
      config.alertOnStatus,
    );

    switch (result.outcome) {
      case 'unknown-donation':
        request.log.warn(logContext, 'Ignoring IPN for an unknown donation');
        break;
      case 'invoice-mismatch':
        request.log.warn(
          { ...logContext, expectedInvoiceId: result.donation.nowpaymentsInvoiceId },
          'Ignoring IPN whose invoice does not match the donation',
        );
        break;
      case 'stale':
        request.log.info({ ...logContext, currentStatus: result.donation.status }, 'Ignoring outdated IPN');
        break;
      case 'applied':
        request.log.info(logContext, 'Payment status updated');
        if (result.alertTriggered) {
          request.log.info(logContext, 'Donation alert triggered');
          try {
            onDonationAlert(result.donation);
          } catch (error) {
            // The payment is recorded either way; a broken alert channel must not
            // make NOWPayments retry a callback that has already been applied.
            request.log.error({ ...logContext, err: error }, 'Delivering the donation alert failed');
          }
        }
        break;
    }
    return reply.code(200).send({ ok: true });
  });
}
