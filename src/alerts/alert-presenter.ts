/**
 * Turns a donation into what is shown and spoken on stream, applying the
 * streamer's filters. The single place alerts are built, so no path (live,
 * replayed, test, speech after a restart) can skip a filter.
 *
 * Filters apply at display time only. The donation keeps exactly what the donor
 * wrote, so the streamer can still see it, and changing a filter takes effect
 * for every alert shown afterwards, including replays.
 */
import type { Donation, PurchasedSound } from '../donations/donation-repository.ts';
import { formatMoneyForDisplay } from '../money.ts';
import { buildSpeechText } from '../tts/alert-speech.ts';
import { createBannedWordFilter } from './banned-words.ts';
import type { OverlayAlert } from './alert-hub.ts';

/** The donation fields an alert is built from. Test alerts supply these directly. */
export type AlertSource = {
  readonly id: string;
  readonly donorName: string;
  readonly message: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Set for a soundboard purchase: the sound paid for. */
  readonly sound?: PurchasedSound;
};

export type PresentedAlert = {
  readonly alert: OverlayAlert;
  /** What to say, or `null` when this alert is not to be spoken. */
  readonly speechText: string | null;
};

export type AlertFilterRules = {
  /** Words and phrases to mask, compared case-insensitively. */
  readonly bannedWords: readonly string[];
  /** Below this, the alert shows without the donor's message. */
  readonly messageMinAmountMinor: number;
  /** Below this, the alert is not read aloud. */
  readonly speechMinAmountMinor: number;
  /** Speech template, or `null` when text-to-speech is off. */
  readonly speechTemplate: string | null;
  /**
   * Where the overlay fetches a soundboard sound, or `null` when that sound is
   * no longer listed (the alert then plays the usual alert sound instead).
   */
  readonly soundboardPath?: (soundId: string) => string | null;
};

/** The longest a purchased sound may play on stream. */
export const soundboardSoundLimitMs = 20_000;

/** Material Symbols "volume_up" (Apache 2.0), shown on soundboard cards. */
const speakerIconPath =
  'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';

export type AlertPresenter = (source: AlertSource) => PresentedAlert;

export function donationToAlertSource(donation: Donation): AlertSource {
  return {
    id: donation.publicId,
    donorName: donation.donorName,
    message: donation.message,
    amountMinor: donation.amountMinor,
    currency: donation.currency,
    ...(donation.sound !== null && { sound: donation.sound }),
  };
}

export function createAlertPresenter(rules: AlertFilterRules): AlertPresenter {
  const bannedWords = createBannedWordFilter(rules.bannedWords);

  return (source) => {
    if (source.sound !== undefined) return presentSoundPurchase(source, source.sound);
    const showMessage = source.amountMinor >= rules.messageMinAmountMinor;
    const message = showMessage ? source.message : '';
    const amount = formatMoneyForDisplay(source.amountMinor, source.currency);
    const alert: OverlayAlert = {
      id: source.id,
      donorName: bannedWords.mask(source.donorName),
      message: bannedWords.mask(message),
      amount,
      speak: rules.speechTemplate !== null && source.amountMinor >= rules.speechMinAmountMinor,
    };
    const speechText =
      alert.speak && rules.speechTemplate !== null
        ? buildSpeechText(rules.speechTemplate, {
            // Banned words are dropped rather than masked: a voice reading out
            // "asterisk asterisk" is worse than a short gap.
            donorName: bannedWords.remove(source.donorName),
            message: bannedWords.remove(message),
            amount,
          })
        : null;
    return { alert, speechText };
  };

  /**
   * "NeonRider played Air horn": the sound is the alert, so there is no message
   * and no speech to talk over it.
   */
  function presentSoundPurchase(source: AlertSource, sound: PurchasedSound): PresentedAlert {
    const donorName = bannedWords.mask(source.donorName);
    const path = rules.soundboardPath?.(sound.id) ?? null;
    const alert: OverlayAlert = {
      id: source.id,
      donorName,
      message: '',
      amount: formatMoneyForDisplay(source.amountMinor, source.currency),
      speak: false,
      kind: 'sound',
      headline: [
        { text: `${donorName} played `, emphasis: false },
        { text: sound.name, emphasis: true },
      ],
      badge: { label: 'Soundboard', iconPath: speakerIconPath },
      ...(path !== null && { sound: { type: 'file', path }, soundLimitMs: soundboardSoundLimitMs }),
    };
    return { alert, speechText: null };
  }
}
