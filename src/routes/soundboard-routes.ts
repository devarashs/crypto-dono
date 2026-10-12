/**
 * Public soundboard routes, registered only when soundboard.json exists.
 *
 *   GET  /sounds             pick a sound and pay for it
 *   POST /sounds             validate → store → NOWPayments invoice → 303 to checkout
 *   GET  /sounds/:id/audio   a sound's file, so viewers can preview it
 *
 * Sounds are looked up by id in the validated list, never by file name, so
 * only files the streamer listed are reachable, and the price charged is
 * always the listed one.
 */
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import type { NowPaymentsClient } from '../nowpayments/nowpayments-client.ts';
import { validateSoundForm } from '../soundboard/sound-form.ts';
import type { Sound } from '../soundboard/soundboard.ts';
import { renderSoundboardPage } from '../web/soundboard-page.ts';
import { sendHtml, startCheckout } from './donation-routes.ts';

export type SoundboardRouteDependencies = {
  readonly config: Config & { readonly soundboard: readonly Sound[] };
  readonly donations: DonationRepository;
  readonly nowPayments: NowPaymentsClient;
};

export function registerSoundboardRoutes(app: FastifyInstance, dependencies: SoundboardRouteDependencies): void {
  const { config, donations } = dependencies;
  const soundsById = new Map(config.soundboard.map((sound) => [sound.id, sound]));
  const pageModel = {
    streamerName: config.streamerName,
    currency: config.donation.currency,
    sounds: config.soundboard,
    leaderboardEnabled: config.leaderboardEnabled,
  };

  app.get<{ Querystring: { cancelled?: string } }>('/sounds', async (request, reply) => {
    const notice =
      request.query.cancelled === undefined ? undefined : "The payment didn't go through. You can try again below.";
    return sendHtml(reply, 200, renderSoundboardPage({ ...pageModel, ...(notice !== undefined && { notice }) }));
  });

  app.post(
    '/sounds',
    // Each accepted submission creates a NOWPayments invoice, as on /donate.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const result = validateSoundForm(request.body, config.soundboard);
      if (!result.ok) {
        return sendHtml(reply, 400, renderSoundboardPage({ ...pageModel, values: result.values, errors: result.errors }));
      }
      const { purchase } = result;
      const donation = donations.create({
        donorName: purchase.donorName,
        message: '',
        amountMinor: purchase.sound.priceMinor,
        currency: config.donation.currency,
        // As on /donate: never list someone who was not asked.
        showOnLeaderboard: config.leaderboardEnabled && purchase.showOnLeaderboard,
        sound: { id: purchase.sound.id, name: purchase.sound.name },
      });
      return startCheckout(dependencies, request, reply, donation, {
        description: `Sound: ${purchase.sound.name}`,
        cancelPath: '/sounds?cancelled=1',
      });
    },
  );

  app.get<{ Params: { id: string } }>('/sounds/:id/audio', async (request, reply) => {
    const sound = soundsById.get(request.params.id);
    if (sound === undefined) return reply.callNotFound();
    return reply.sendFile(sound.fileName, config.alert.assetsDirectory);
  });
}
