/**
 * Validation and normalisation of the public donation form.
 *
 * Everything a donor types ends up on stream, so text is normalised here before
 * it is stored: invisible and control characters removed, whitespace collapsed.
 * Content filtering (banned words, per-amount thresholds) is a separate concern
 * applied when alerts are shown.
 */
import { formatMinorUnits, formatMoneyForDisplay, parseAmountToMinorUnits } from '../money.ts';

export const donorNameMaxLength = 32;
export const anonymousDonorName = 'Anonymous';

export type DonationFormRules = {
  readonly currency: string;
  /** From MESSAGE_MAX_LENGTH; counted in characters (code points). */
  readonly messageMaxLength: number;
  /** One-tap amounts offered as chips; a submitted chip must be one of these. */
  readonly presetsMinor?: readonly number[];
  readonly fractionDigits: number;
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;
};

/** The raw values as typed, echoed back into the form when it is re-shown. */
export type DonationFormValues = {
  readonly donorName: string;
  readonly amount: string;
  readonly message: string;
};

export type DonationFormErrors = Partial<Record<keyof DonationFormValues, string>>;

export type ValidDonation = {
  readonly donorName: string;
  readonly message: string;
  readonly amountMinor: number;
};

export type DonationFormResult =
  | { readonly ok: true; readonly donation: ValidDonation }
  | { readonly ok: false; readonly errors: DonationFormErrors; readonly values: DonationFormValues };

/**
 * @param body The parsed form body; any shape, since it comes from the internet.
 * @param rules Currency and amount limits from configuration.
 */
export function validateDonationForm(body: unknown, rules: DonationFormRules): DonationFormResult {
  const values = readFormValues(body, rules);
  const errors: DonationFormErrors = {};

  const donorName = normaliseText(values.donorName);
  if (codePointLength(donorName) > donorNameMaxLength) {
    errors.donorName = `Keep your name to ${donorNameMaxLength} characters or fewer.`;
  }

  const message = normaliseText(values.message);
  if (codePointLength(message) > rules.messageMaxLength) {
    errors.message = `Keep your message to ${rules.messageMaxLength} characters or fewer.`;
  }

  const amountMinor = parseAmountToMinorUnits(values.amount, rules.fractionDigits);
  const minimum = formatMoneyForDisplay(rules.minAmountMinor, rules.currency);
  const maximum = formatMoneyForDisplay(rules.maxAmountMinor, rules.currency);
  if (values.amount.trim() === '') {
    errors.amount = 'Enter an amount.';
  } else if (amountMinor === undefined) {
    errors.amount =
      rules.fractionDigits > 0
        ? `Enter a number with at most ${rules.fractionDigits} decimals, like ${formatMinorUnits(rules.minAmountMinor, rules.fractionDigits)}.`
        : 'Enter a whole number.';
  } else if (amountMinor < rules.minAmountMinor) {
    errors.amount = `The minimum is ${minimum}.`;
  } else if (amountMinor > rules.maxAmountMinor) {
    errors.amount = `The maximum is ${maximum}.`;
  }

  if (Object.keys(errors).length > 0 || amountMinor === undefined) {
    return { ok: false, errors, values };
  }
  return {
    ok: true,
    donation: { donorName: donorName === '' ? anonymousDonorName : donorName, message, amountMinor },
  };
}

/** Value of the chip that reveals the free amount field. */
export const customAmountChip = 'custom';

function readFormValues(body: unknown, rules: DonationFormRules): DonationFormValues {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return {
    donorName: readString(record.donorName),
    amount: resolveAmount(readString(record.preset), readString(record.amount), rules),
    message: readString(record.message),
  };
}

/**
 * A preset chip supplies the amount; "custom" or no chip means the typed field.
 * A chip value that is not one of the configured presets is ignored rather than
 * trusted, so a crafted request cannot pass off an arbitrary "preset".
 */
function resolveAmount(preset: string, typedAmount: string, rules: DonationFormRules): string {
  if (preset === '' || preset === customAmountChip) return typedAmount;
  const presetMinor = parseAmountToMinorUnits(preset, rules.fractionDigits);
  if (presetMinor !== undefined && (rules.presetsMinor ?? []).includes(presetMinor)) return preset;
  return typedAmount;
}

/** A repeated form field arrives as an array; anything but one string counts as empty. */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * NFC-normalises, strips control and format characters, and collapses runs of
 * whitespace (including newlines) to single spaces.
 *
 * Format characters (Unicode category Cf) include bidirectional overrides and
 * zero-width joiners, which can make an on-stream alert render differently from
 * what the streamer sees in the admin page.
 */
export function normaliseText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (/\s/.test(character) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Length as a person counts it for most text: one per code point, not per UTF-16 unit. */
function codePointLength(text: string): number {
  return [...text].length;
}
