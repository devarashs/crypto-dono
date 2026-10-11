import { describe, expect, it } from 'vitest';
import {
  anonymousDonorName,
  normaliseText,
  validateDonationForm,
  type DonationFormRules,
} from '../src/donations/donation-form.ts';

const usdRules: DonationFormRules = {
  currency: 'usd',
  fractionDigits: 2,
  minAmountMinor: 100,
  maxAmountMinor: 100000,
  messageMaxLength: 300,
};

function validate(body: unknown, rules = usdRules) {
  return validateDonationForm(body, rules);
}

describe('validateDonationForm', () => {
  it('accepts a complete donation', () => {
    expect(validate({ donorName: 'Ann', amount: '5.50', message: 'gg' })).toEqual({
      ok: true,
      donation: { donorName: 'Ann', message: 'gg', amountMinor: 550 },
    });
  });

  it('defaults an empty name to Anonymous and allows an empty message', () => {
    expect(validate({ donorName: '   ', amount: '5' })).toEqual({
      ok: true,
      donation: { donorName: anonymousDonorName, message: '', amountMinor: 500 },
    });
  });

  it('accepts the exact minimum and maximum', () => {
    expect(validate({ amount: '1.00' }).ok).toBe(true);
    expect(validate({ amount: '1000' }).ok).toBe(true);
  });

  it.each([
    ['', 'Enter an amount.'],
    ['   ', 'Enter an amount.'],
    ['0.99', 'The minimum is $1.00.'],
    ['1000.01', 'The maximum is $1,000.00.'],
    ['abc', 'Enter a number with at most 2 decimals, like 1.00.'],
    ['5.555', 'Enter a number with at most 2 decimals, like 1.00.'],
    ['-5', 'Enter a number with at most 2 decimals, like 1.00.'],
  ])('rejects amount %j', (amount, message) => {
    const result = validate({ amount });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.amount).toBe(message);
  });

  it('asks for a whole number in a zero-decimal currency', () => {
    const result = validate(
      { amount: '5.5' },
      { currency: 'jpy', fractionDigits: 0, minAmountMinor: 100, maxAmountMinor: 100000, messageMaxLength: 300 },
    );
    expect(result.ok === false && result.errors.amount).toBe('Enter a whole number.');
  });

  it('counts name and message length in code points, so emoji count once', () => {
    expect(validate({ amount: '5', donorName: '😀'.repeat(32) }).ok).toBe(true);
    expect(validate({ amount: '5', donorName: '😀'.repeat(33) }).ok).toBe(false);
    expect(validate({ amount: '5', message: 'é'.repeat(300) }).ok).toBe(true);
    expect(validate({ amount: '5', message: 'é'.repeat(301) }).ok).toBe(false);
  });

  it('uses the configured message length', () => {
    const rules = { ...usdRules, messageMaxLength: 20 };
    expect(validate({ amount: '5', message: 'x'.repeat(20) }, rules).ok).toBe(true);
    const tooLong = validate({ amount: '5', message: 'x'.repeat(21) }, rules);
    expect(tooLong.ok === false && tooLong.errors.message).toBe('Keep your message to 20 characters or fewer.');
  });

  it('measures length after normalisation, so padding does not count', () => {
    expect(validate({ amount: '5', donorName: `   ${'a'.repeat(32)}   ` }).ok).toBe(true);
  });

  it('reports every field error at once and echoes the raw values back', () => {
    const body = { donorName: 'x'.repeat(40), amount: 'nope', message: 'y'.repeat(400) };
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['amount', 'donorName', 'message']);
      expect(result.values).toEqual(body);
    }
  });

  it.each([null, undefined, 'string body', 42, []])('treats a %j body as empty', (body) => {
    const result = validate(body);
    expect(result.ok === false && result.errors.amount).toBe('Enter an amount.');
  });

  it('treats a repeated field (array) as empty rather than picking one', () => {
    const result = validate({ amount: ['5', '500000'] });
    expect(result.ok === false && result.errors.amount).toBe('Enter an amount.');
  });
});

describe('amount chips', () => {
  const rules = { ...usdRules, presetsMinor: [500, 1000, 2500] };

  it('takes the amount from a chosen preset chip', () => {
    expect(validate({ preset: '10.00', amount: '' }, rules)).toMatchObject({ ok: true, donation: { amountMinor: 1000 } });
  });

  it('accepts a preset written without decimals', () => {
    expect(validate({ preset: '25' }, rules)).toMatchObject({ ok: true, donation: { amountMinor: 2500 } });
  });

  it('uses the typed amount with the custom chip, ignoring nothing else', () => {
    expect(validate({ preset: 'custom', amount: '7.25' }, rules)).toMatchObject({ ok: true, donation: { amountMinor: 725 } });
  });

  it('uses the typed amount when no chip is sent', () => {
    expect(validate({ amount: '7' }, rules)).toMatchObject({ ok: true, donation: { amountMinor: 700 } });
  });

  it('ignores a chip value that is not a configured preset', () => {
    const result = validate({ preset: '999', amount: '' }, rules);
    expect(result.ok === false && result.errors.amount).toBe('Enter an amount.');
    expect(validate({ preset: '0.01', amount: '6' }, rules)).toMatchObject({ ok: true, donation: { amountMinor: 600 } });
  });

  it('echoes the resolved amount, so the page can re-select the chip', () => {
    const result = validate({ preset: '10.00', message: 'x'.repeat(400) }, rules);
    expect(result.ok === false && result.values.amount).toBe('10.00');
  });
});

describe('normaliseText', () => {
  it.each([
    ['  hello   world  ', 'hello world'],
    ['line one\nline two\r\n\tthree', 'line one line two three'],
    ['bell\u0007char', 'bellchar'],
    // Right-to-left override would visually reverse the rest of an alert.
    ['abc‮dcba', 'abcdcba'],
    ['zero​width', 'zerowidth'],
    ['﻿bom', 'bom'],
    // Composed and decomposed é become the same string.
    ['é', 'é'],
    ['héllo 👋 世界', 'héllo 👋 世界'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseText(input)).toBe(expected);
  });
});
