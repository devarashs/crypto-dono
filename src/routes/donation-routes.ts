/**
 * Public donation flow: the form, invoice creation, and the return pages.
 *
 *   GET  /          donation form
 *   POST /donate    validate → store → create NOWPayments invoice → 303 to checkout
 *   GET  /thanks    where NOWPayments sends the donor after paying
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config.ts';
import { validateDonationForm } from '../donations/donation-form.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import { formatMinorUnits } from '../money.ts';
import type { NowPaymentsClient } from '../nowpayments/nowpayments-client.ts';
import type { SafeHtml } from '../web/html.ts';
import { renderDonationPage, renderErrorPage, renderThanksPage } from '../web/pages.ts';

/** Path NOWPayments posts payment status changes to; handled by the webhook routes. */
export const nowPaymentsWebhookPath = '/webhooks/nowpayments';

export type DonationRouteDependencies = {
  readonly config: Config;
  readonly donations: DonationRepository;
  readonly nowPayments: NowPaymentsClient;
};

export function registerDonationRoutes(app: FastifyInstance, dependencies: DonationRouteDependencies): void {
  const { config, donations, nowPayments } = dependencies;
  const formRules = { ...config.donation, messageMaxLength: config.filters.messageMaxLength };
  const pageModel = {
    streamerName: config.streamerName,
    messageMaxLength: config.filters.messageMaxLength,
    messageMinAmountMinor: config.filters.messageMinAmountMinor,
    currency: config.donation.currency,
    fractionDigits: config.donation.fractionDigits,
    minAmountMinor: config.donation.minAmountMinor,
    maxAmountMinor: config.donation.maxAmountMinor,
  };

  app.get<{ Querystring: { cancelled?: string } }>('/', async (request, reply) => {
    const notice =
      request.query.cancelled === undefined ? undefined : "The payment didn't go through. You can try again below.";
    return sendHtml(reply, 200, renderDonationPage({ ...pageModel, ...(notice !== undefined && { notice }) }));
  });

  app.post(
    '/donate',
    {
      // Each accepted submission creates a NOWPayments invoice, so this is the
      // endpoint worth protecting from scripted abuse.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const result = validateDonationForm(request.body, formRules);
      if (!result.ok) {
        return sendHtml(reply, 400, renderDonationPage({ ...pageModel, values: result.values, errors: result.errors }));
      }

      // Stored first, so the name and message survive even if the invoice call fails
      // or the donor abandons checkout.
      const donation = donations.create({ ...result.donation, currency: config.donation.currency });

      let invoice;
      try {
        invoice = await nowPayments.createInvoice({
          priceAmount: formatMinorUnits(donation.amountMinor, config.donation.fractionDigits),
          priceCurrency: donation.currency,
          orderId: donation.publicId,
          orderDescription:
            config.streamerName === '' ? 'Stream donation' : `Donation to ${config.streamerName}`,
          ipnCallbackUrl: `${config.publicBaseUrl}${nowPaymentsWebhookPath}`,
          successUrl: `${config.publicBaseUrl}/thanks?donation=${encodeURIComponent(donation.publicId)}`,
          cancelUrl: `${config.publicBaseUrl}/?cancelled=1`,
        });
      } catch (error) {
        request.log.error({ err: error, donationId: donation.publicId }, 'Creating the NOWPayments invoice failed');
        return sendHtml(
          reply,
          502,
          renderErrorPage(
            'Payment is unavailable right now',
            "We couldn't reach the payment provider, so nothing was charged. Please try again in a minute.",
          ),
        );
      }

      donations.setInvoiceId(donation.publicId, invoice.invoiceId);
      request.log.info({ donationId: donation.publicId, invoiceId: invoice.invoiceId }, 'Invoice created');
      // 303 so the browser follows with a GET and a refresh cannot resubmit the form.
      return reply.redirect(invoice.invoiceUrl, 303);
    },
  );

  app.get<{ Querystring: { donation?: string } }>('/thanks', async (request, reply) => {
    const donationId = request.query.donation;
    const donation = typeof donationId === 'string' ? donations.findByPublicId(donationId) : undefined;
    return sendHtml(
      reply,
      200,
      renderThanksPage(
        donation === undefined
          ? {}
          : { donorName: donation.donorName, amountMinor: donation.amountMinor, currency: donation.currency },
      ),
    );
  });
}

export function sendHtml(reply: FastifyReply, statusCode: number, page: SafeHtml): FastifyReply {
  return reply.code(statusCode).type('text/html; charset=utf-8').send(page.value);
}
