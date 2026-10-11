/**
 * Turns a donation into what is shown and spoken on stream, applying the
 * streamer's filters. The single place alerts are built, so no path (live,
 * replayed, test, speech after a restart) can skip a filter.
 *
 * Filters apply at display time only. The donation keeps exactly what the donor
 * wrote, so the streamer can still see it, and changing a filter takes effect
 * for every alert shown afterwards, including replays.
 */
import type { Donation } from '../donations/donation-repository.ts';
import { formatMoneyForDisplay } from '../money.ts';
import { buildSpeechText } from '../tts/alert-speech.ts';
import type { OverlayAlert } from './alert-hub.ts';

/** The donation fields an alert is built from. Test alerts supply these directly. */
export type AlertSource = {
  readonly id: string;
  readonly donorName: string;
  readonly message: string;
  readonly amountMinor: number;
  readonly currency: string;
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
};

export type AlertPresenter = (source: AlertSource) => PresentedAlert;

export function donationToAlertSource(donation: Donation): AlertSource {
  return {
    id: donation.publicId,
    donorName: donation.donorName,
    message: donation.message,
    amountMinor: donation.amountMinor,
    currency: donation.currency,
  };
}

export function createAlertPresenter(rules: AlertFilterRules): AlertPresenter {
  const bannedPattern = compileBannedPattern(rules.bannedWords);

  return (source) => {
    const showMessage = source.amountMinor >= rules.messageMinAmountMinor;
    const message = showMessage ? source.message : '';
    const amount = formatMoneyForDisplay(source.amountMinor, source.currency);
    const alert: OverlayAlert = {
      id: source.id,
      donorName: maskBannedWords(source.donorName, bannedPattern),
      message: maskBannedWords(message, bannedPattern),
      amount,
      speak: rules.speechTemplate !== null && source.amountMinor >= rules.speechMinAmountMinor,
    };
    const speechText =
      alert.speak && rules.speechTemplate !== null
        ? buildSpeechText(rules.speechTemplate, {
            // Banned words are dropped rather than masked: a voice reading out
            // "asterisk asterisk" is worse than a short gap.
            donorName: removeBannedWords(source.donorName, bannedPattern),
            message: removeBannedWords(message, bannedPattern),
            amount,
          })
        : null;
    return { alert, speechText };
  };
}

/**
 * One case-insensitive pattern for every banned word. A match must not be part
 * of a longer word ("ass" does not hit "class"), judged by Unicode letters and
 * digits so it works beyond English.
 *
 * This catches plain use. It does not try to catch deliberate evasion (spacing,
 * look-alike characters, leetspeak); no word list can, and trying produces false
 * positives on innocent messages.
 */
function compileBannedPattern(bannedWords: readonly string[]): RegExp | null {
  const words = bannedWords.map((word) => word.normalize('NFC').trim()).filter((word) => word !== '');
  if (words.length === 0) return null;
  // Longest first, so a phrase wins over a word it contains.
  const alternatives = [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

function maskBannedWords(text: string, pattern: RegExp | null): string {
  if (pattern === null) return text;
  return text.replace(pattern, (match) => '*'.repeat([...match].length));
}

function removeBannedWords(text: string, pattern: RegExp | null): string {
  if (pattern === null) return text;
  return text.replace(pattern, '').replace(/\s+/g, ' ').trim();
}
