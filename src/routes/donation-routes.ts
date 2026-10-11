/**
 * Public donation flow: the form, invoice creation, and the return pages.
 *
 *   GET  /          donation form
 *   POST /donate    validate → store → create NOWPayments invoice → 303 to checkout
 *   GET  /thanks    where NOWPayments sends the donor after paying
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createBannedWordFilter } from '../alerts/banned-words.ts';
import type { Config } from '../config.ts';
import { validateDonationForm } from '../donations/donation-form.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import type { LeaderboardQueries } from '../donations/leaderboard.ts';
import { formatMinorUnits, formatMoneyForDisplay } from '../money.ts';
import type { NowPaymentsClient } from '../nowpayments/nowpayments-client.ts';
import type { SafeHtml } from '../web/html.ts';
import { renderDonationPage, renderErrorPage, renderThanksPage, type LeaderboardModel } from '../web/pages.ts';

/** Path NOWPayments posts payment status changes to; handled by the webhook routes. */
export const nowPaymentsWebhookPath = '/webhooks/nowpayments';

export type DonationRouteDependencies = {
  readonly config: Config;
  readonly donations: DonationRepository;
  readonly leaderboard: LeaderboardQueries;
  readonly nowPayments: NowPaymentsClient;
};

/** Rows on each leaderboard view. */
const topDonorLimit = 100;
const recentLimit = 25;

export function registerDonationRoutes(app: FastifyInstance, dependencies: DonationRouteDependencies): void {
  const { config, donations, leaderboard, nowPayments } = dependencies;
  const bannedWords = createBannedWordFilter(config.filters.bannedWords);

  /**
   * Read on every page view: a single streamer's donation volume makes these
   * two indexed, bounded queries cheap, and the board is never stale.
   */
  function loadLeaderboard(): LeaderboardModel | null {
    if (!config.leaderboardEnabled) return null;
    const currency = config.donation.currency;
    return {
      currency,
      topDonors: leaderboard
        .topDonors(currency, topDonorLimit)
        .map((donor) => ({ ...donor, donorName: bannedWords.mask(donor.donorName) })),
      recent: leaderboard
        .recent(currency, recentLimit)
        .map((donation) => ({ ...donation, donorName: bannedWords.mask(donation.donorName) })),
    };
  }
  const formRules = { ...config.donation, messageMaxLength: config.filters.messageMaxLength };
  const presets = config.donation.presetsMinor.map((amountMinor) => ({
    value: formatMinorUnits(amountMinor, config.donation.fractionDigits),
    label: formatMoneyForDisplay(amountMinor, config.donation.currency),
  }));
  const pageModel = {
    streamerName: config.streamerName,
    presets,
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
    return sendHtml(
      reply,
      200,
      renderDonationPage({ ...pageModel, leaderboard: loadLeaderboard(), ...(notice !== undefined && { notice }) }),
    );
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
        return sendHtml(
          reply,
          400,
          renderDonationPage({ ...pageModel, leaderboard: loadLeaderboard(), values: result.values, errors: result.errors }),
        );
      }

      // Stored first, so the name and message survive even if the invoice call fails
      // or the donor abandons checkout.
      const donation = donations.create({
        ...result.donation,
        currency: config.donation.currency,
        // With the leaderboard off the donor was never asked, so never list them:
        // turning it on later must not publish names collected without the choice.
        showOnLeaderboard: config.leaderboardEnabled && result.donation.showOnLeaderboard,
      });

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
