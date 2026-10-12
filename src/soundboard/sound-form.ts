/**
 * Validation of the soundboard form: which sound, and the viewer's name.
 *
 * The sound is looked up in the streamer's list by id, and its price comes from
 * that list. Nothing the form sends can change what is charged.
 */
import { anonymousDonorName, donorNameMaxLength, normaliseText } from '../donations/donation-form.ts';
import type { Sound } from './soundboard.ts';

export type SoundFormValues = {
  readonly donorName: string;
  /** The chosen sound's id, as submitted. */
  readonly soundId: string;
  /** The "show me on the public leaderboard" checkbox. */
  readonly listed: boolean;
};

export type SoundFormErrors = Partial<Record<'donorName' | 'soundId', string>>;

export type ValidSoundPurchase = {
  readonly donorName: string;
  readonly sound: Sound;
  readonly showOnLeaderboard: boolean;
};

export type SoundFormResult =
  | { readonly ok: true; readonly purchase: ValidSoundPurchase }
  | { readonly ok: false; readonly errors: SoundFormErrors; readonly values: SoundFormValues };

/**
 * @param body The parsed form body; any shape, since it comes from the internet.
 * @param sounds The streamer's validated sound list.
 */
export function validateSoundForm(body: unknown, sounds: readonly Sound[]): SoundFormResult {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const values: SoundFormValues = {
    donorName: typeof record.donorName === 'string' ? record.donorName : '',
    soundId: typeof record.soundId === 'string' ? record.soundId : '',
    // A browser omits an unticked checkbox entirely, so absent means "opted out".
    listed: record.listed === 'on',
  };
  const errors: SoundFormErrors = {};

  const donorName = normaliseText(values.donorName);
  if ([...donorName].length > donorNameMaxLength) {
    errors.donorName = `Keep your name to ${donorNameMaxLength} characters or fewer.`;
  }
  const sound = sounds.find((candidate) => candidate.id === values.soundId);
  if (sound === undefined) {
    errors.soundId = values.soundId === '' ? 'Pick a sound.' : 'That sound is no longer available. Pick another.';
  }

  if (Object.keys(errors).length > 0 || sound === undefined) return { ok: false, errors, values };
  return {
    ok: true,
    purchase: {
      donorName: donorName === '' ? anonymousDonorName : donorName,
      sound,
      showOnLeaderboard: values.listed,
    },
  };
}
