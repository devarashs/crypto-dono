/**
 * Conversion between decimal amount strings and integer minor units.
 *
 * Amounts never pass through binary floating point here: "0.1" + "0.2" style
 * errors are unacceptable on money. Parsing is done on the string digits.
 */

/**
 * Number of decimal places a currency uses (2 for USD, 0 for JPY, 3 for KWD).
 *
 * @param currencyCode ISO 4217 code, either case.
 * @throws {RangeError} If the code is not a currency the runtime knows.
 */
export function currencyFractionDigits(currencyCode: string): number {
  const digits = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: currencyCode,
  }).resolvedOptions().maximumFractionDigits;
  // Always defined for style "currency"; the fallback only satisfies the types.
  return digits ?? 2;
}

/**
 * Parses a user-entered decimal amount into integer minor units.
 *
 * Accepts digits with an optional "." and at most `fractionDigits` decimals,
 * surrounding whitespace ignored: "5", "5.5", "5.50", "0.99". Rejects signs,
 * exponents, thousands separators, commas, and anything ambiguous.
 *
 * @returns Minor units (e.g. 550 for "5.50" with 2 digits), or `undefined` if
 *   the input is not a well-formed amount or exceeds the safe integer range.
 */
export function parseAmountToMinorUnits(input: string, fractionDigits: number): number | undefined {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(input.trim());
  if (match === null) return undefined;
  const wholePart = match[1] ?? '';
  const fractionPart = match[2] ?? '';
  if (fractionPart.length > fractionDigits) return undefined;
  // "5." is accepted as 5, but a lone "." never reaches here (needs a digit).
  const minorUnits = BigInt(wholePart + fractionPart.padEnd(fractionDigits, '0'));
  if (minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(minorUnits);
}

/**
 * Formats minor units as a plain decimal string, e.g. 550 → "5.50".
 * No currency symbol and no grouping: this is for APIs, not for display.
 *
 * @throws {RangeError} If `minorUnits` is not a non-negative safe integer.
 */
export function formatMinorUnits(minorUnits: number, fractionDigits: number): string {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new RangeError(`Expected a non-negative safe integer, got ${minorUnits}`);
  }
  if (fractionDigits === 0) return String(minorUnits);
  const digits = String(minorUnits).padStart(fractionDigits + 1, '0');
  return `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
}

/**
 * Formats minor units for people, e.g. 550 USD → "$5.50".
 *
 * @param locale BCP 47 locale for symbol placement and separators.
 */
export function formatMoneyForDisplay(minorUnits: number, currencyCode: string, locale = 'en'): string {
  const fractionDigits = currencyFractionDigits(currencyCode);
  // Intl takes a decimal string exactly, avoiding a lossy division by 10^n.
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(
    formatMinorUnits(minorUnits, fractionDigits) as unknown as number,
  );
}
