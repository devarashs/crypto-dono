/**
 * The soundboard: a list of sounds the streamer provides, each with a price,
 * that viewers pay to play on stream.
 *
 * Read from a JSON file at startup, like the rest of the configuration, so a
 * typo stops the service with a message instead of failing mid-stream:
 *
 *   [
 *     { "id": "airhorn", "name": "Air horn", "price": "2.50", "file": "airhorn.mp3" }
 *   ]
 *
 * Prices are in DONATION_CURRENCY, as a string or a plain number.
 */
import { z } from 'zod';
import { parseAmountToMinorUnits } from '../money.ts';

export type Sound = {
  /** Stable identifier, used in URLs and stored with each purchase. */
  readonly id: string;
  /** Shown to viewers and on stream. */
  readonly name: string;
  readonly priceMinor: number;
  /** Plain file name inside CUSTOM_ASSETS_DIR. */
  readonly fileName: string;
};

/** Enough for a real soundboard; more is a page nobody scrolls. */
export const maximumSounds = 50;

const entrySchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'id must be 1 to 64 letters, digits, dashes or underscores'),
    name: z.string().trim().min(1, 'name must not be empty').max(40, 'name must be at most 40 characters'),
    price: z.union([z.string(), z.number()]),
    file: z.string(),
  })
  .strict();

export type SoundboardRules = {
  readonly fractionDigits: number;
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;
};

/**
 * Parses the soundboard file's text. Checks shape, ids and prices; whether each
 * file exists is left to the caller, which owns the asset folder.
 *
 * @returns The sounds in file order, and one issue per problem found (all of
 *   them at once, so the streamer fixes the file in one pass).
 */
export function parseSoundboard(
  text: string,
  rules: SoundboardRules,
): { readonly sounds: readonly Sound[]; readonly issues: readonly string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { sounds: [], issues: [`not valid JSON (${(error as Error).message})`] };
  }
  if (!Array.isArray(data)) return { sounds: [], issues: ['must be a JSON list of sounds: [ { ... }, ... ]'] };
  if (data.length === 0) return { sounds: [], issues: ['lists no sounds; delete the file to turn the soundboard off'] };
  if (data.length > maximumSounds) return { sounds: [], issues: [`lists ${data.length} sounds; at most ${maximumSounds}`] };

  const sounds: Sound[] = [];
  const issues: string[] = [];
  const seenIds = new Set<string>();
  data.forEach((entry, index) => {
    const label = `sound ${index + 1}${typeof entry?.id === 'string' ? ` ("${entry.id}")` : ''}`;
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.');
        issues.push(`${label}: ${issue.code === 'unrecognized_keys' || field === '' ? issue.message : `${field}: ${issue.message}`}`);
      }
      return;
    }
    const { id, name, price, file } = parsed.data;
    if (seenIds.has(id)) issues.push(`${label}: the id "${id}" is used more than once`);
    seenIds.add(id);
    const priceMinor = parseAmountToMinorUnits(String(price), rules.fractionDigits);
    if (priceMinor === undefined || priceMinor < rules.minAmountMinor || priceMinor > rules.maxAmountMinor) {
      issues.push(`${label}: price must be an amount between DONATION_MIN_AMOUNT and DONATION_MAX_AMOUNT`);
      return;
    }
    sounds.push({ id, name, priceMinor, fileName: file });
  });
  return { sounds, issues };
}
