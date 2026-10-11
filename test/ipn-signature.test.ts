import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalForms, signCanonicalBody, verifyIpnSignature } from '../src/nowpayments/ipn-signature.ts';

const secret = 'test-ipn-secret';

/** NOWPayments' own Node sample, verbatim apart from types, used as the oracle. */
function referenceSortObject(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      const value = obj[key];
      result[key] = value && typeof value === 'object' ? referenceSortObject(value as Record<string, unknown>) : value;
      return result;
    }, {});
}

function referenceSignature(params: Record<string, unknown>): string {
  return createHmac('sha512', secret).update(JSON.stringify(referenceSortObject(params))).digest('hex');
}

// The payment example from the NOWPayments docs, with the missing comma fixed.
const documentedPayload = {
  payment_id: 123456789,
  parent_payment_id: 987654321,
  invoice_id: null,
  payment_status: 'finished',
  pay_address: 'address',
  payin_extra_id: null,
  price_amount: 1,
  price_currency: 'usd',
  pay_amount: 15,
  actually_paid: 15,
  actually_paid_at_fiat: 0,
  pay_currency: 'trx',
  order_id: null,
  order_description: null,
  purchase_id: '123456789',
  outcome_amount: 14.8106,
  outcome_currency: 'trx',
  payment_extra_ids: null,
  fee: { currency: 'btc', depositFee: 0.09853637216235617, withdrawalFee: 0, serviceFee: 0 },
};

describe('verifyIpnSignature', () => {
  it('accepts a signature produced by the NOWPayments reference code', () => {
    const rawBody = JSON.stringify(documentedPayload);
    expect(verifyIpnSignature(rawBody, referenceSignature(documentedPayload), secret)).toBe('node-reference');
  });

  it('is independent of the key order and whitespace of the received body', () => {
    const shuffled = `{ "fee": {"serviceFee":0, "currency":"btc","withdrawalFee":0,"depositFee":0.09853637216235617},
      ${Object.entries(documentedPayload)
        .filter(([key]) => key !== 'fee')
        .reverse()
        .map(([key, value]) => `"${key}": ${JSON.stringify(value)}`)
        .join(',\n      ')} }`;
    expect(verifyIpnSignature(shuffled, referenceSignature(documentedPayload), secret)).toBe('node-reference');
  });

  it('accepts an upper-case hex signature with surrounding whitespace', () => {
    const signature = ` ${referenceSignature(documentedPayload).toUpperCase()} `;
    expect(verifyIpnSignature(JSON.stringify(documentedPayload), signature, secret)).toBe('node-reference');
  });

  describe('arrays', () => {
    const withArray = { ...documentedPayload, payment_extra_ids: [5513339153, 42] };

    it('accepts the Node reference form, which turns arrays into objects', () => {
      expect(verifyIpnSignature(JSON.stringify(withArray), referenceSignature(withArray), secret)).toBe(
        'node-reference',
      );
    });

    it('accepts the PHP/Python form, which keeps arrays', () => {
      const [, preserved] = canonicalForms(withArray).find(([variant]) => variant === 'arrays-preserved') ?? [];
      expect(preserved).toContain('"payment_extra_ids":[5513339153,42]');
      const signature = signCanonicalBody(preserved ?? '', secret);
      expect(verifyIpnSignature(JSON.stringify(withArray), signature, secret)).toBe('arrays-preserved');
    });
  });

  it('computes one canonical form when there are no arrays', () => {
    expect(canonicalForms(documentedPayload)).toHaveLength(1);
  });

  it('rejects a signature made with a different secret', () => {
    const forged = createHmac('sha512', 'wrong-secret')
      .update(JSON.stringify(referenceSortObject(documentedPayload)))
      .digest('hex');
    expect(verifyIpnSignature(JSON.stringify(documentedPayload), forged, secret)).toBeUndefined();
  });

  it('rejects a body changed after signing', () => {
    const signature = referenceSignature(documentedPayload);
    const tampered = JSON.stringify({ ...documentedPayload, price_amount: 1000 });
    expect(verifyIpnSignature(tampered, signature, secret)).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'abc123'],
    ['not hex', 'z'.repeat(128)],
    ['truncated by one', referenceSignature(documentedPayload).slice(0, 127)],
  ])('rejects a %s signature header', (_label, header) => {
    expect(verifyIpnSignature(JSON.stringify(documentedPayload), header, secret)).toBeUndefined();
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"x"'],
    ['JSON null', 'null'],
    ['empty', ''],
  ])('rejects a body that is %s', (_label, rawBody) => {
    expect(verifyIpnSignature(rawBody, 'a'.repeat(128), secret)).toBeUndefined();
  });
});
