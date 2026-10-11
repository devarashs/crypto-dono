/**
 * Verification of NOWPayments IPN (webhook) signatures.
 *
 * NOWPayments signs each callback with HMAC-SHA512 over the JSON body with its
 * keys sorted, and sends the hex digest in the `x-nowpayments-sig` header. The
 * key is the merchant's IPN secret.
 *
 * Their docs give reference code in three languages that do not agree on arrays:
 * the Node sample's `sortObject` turns an array into an index-keyed object, while
 * the PHP and Python samples keep arrays as arrays. Both canonical forms are
 * computed and either is accepted. That does not weaken verification: each still
 * requires the secret, so an attacker gains nothing from the second form.
 * https://documenter.getpostman.com/view/7907941/2s93JusNJt (Instant Payments Notifications)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVariant = 'node-reference' | 'arrays-preserved';

/**
 * @param rawBody The request body exactly as received.
 * @param signatureHeader Value of `x-nowpayments-sig`, if present.
 * @param ipnSecret The merchant's IPN secret.
 * @returns Which canonical form matched, or `undefined` when none did, the header
 *   is missing, or the body is not a JSON object.
 */
export function verifyIpnSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  ipnSecret: string,
): SignatureVariant | undefined {
  if (signatureHeader === undefined || !/^[0-9a-f]{128}$/i.test(signatureHeader.trim())) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;

  const received = Buffer.from(signatureHeader.trim().toLowerCase(), 'hex');
  for (const [variant, canonical] of canonicalForms(body)) {
    const expected = Buffer.from(signCanonicalBody(canonical, ipnSecret), 'hex');
    // Same length is guaranteed (both SHA-512), which timingSafeEqual requires.
    if (timingSafeEqual(expected, received)) return variant;
  }
  return undefined;
}

/** HMAC-SHA512 of an already-canonical body, hex encoded. Exported for tests. */
export function signCanonicalBody(canonicalBody: string, ipnSecret: string): string {
  return createHmac('sha512', ipnSecret).update(canonicalBody).digest('hex');
}

export function canonicalForms(body: object): ReadonlyArray<readonly [SignatureVariant, string]> {
  const nodeReference = JSON.stringify(sortLikeNodeReference(body));
  const arraysPreserved = JSON.stringify(sortPreservingArrays(body));
  return nodeReference === arraysPreserved
    ? [['node-reference', nodeReference]]
    : [
        ['node-reference', nodeReference],
        ['arrays-preserved', arraysPreserved],
      ];
}

/**
 * Port of `sortObject` from NOWPayments' Node sample, quirk included: any truthy
 * object value, arrays too, is rebuilt as a plain object with sorted keys.
 */
function sortLikeNodeReference(value: object): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      const child = source[key];
      sorted[key] = child && typeof child === 'object' ? sortLikeNodeReference(child) : child;
      return sorted;
    }, {});
}

/** Recursively sorts object keys and leaves arrays as arrays, like the PHP and Python samples. */
function sortPreservingArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPreservingArrays);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortPreservingArrays(source[key]);
  return sorted;
}
