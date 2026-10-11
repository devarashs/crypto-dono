import { describe, expect, it } from 'vitest';
import {
  currencyFractionDigits,
  formatMinorUnits,
  formatMoneyForDisplay,
  parseAmountToMinorUnits,
} from '../src/money.ts';

describe('currencyFractionDigits', () => {
  it.each([
    ['usd', 2],
    ['USD', 2],
    ['eur', 2],
    ['jpy', 0],
    ['kwd', 3],
  ])('%s has %i decimals', (code, digits) => {
    expect(currencyFractionDigits(code)).toBe(digits);
  });

  it.each(['us', 'dollars', ''])('rejects %j', (code) => {
    expect(() => currencyFractionDigits(code)).toThrow(RangeError);
  });
});

describe('parseAmountToMinorUnits', () => {
  it.each([
    ['5', 2, 500],
    ['5.', 2, 500],
    ['5.5', 2, 550],
    ['5.50', 2, 550],
    ['0.01', 2, 1],
    ['0', 2, 0],
    ['007.10', 2, 710],
    [' 12.34 ', 2, 1234],
    ['1000', 0, 1000],
    ['1.234', 3, 1234],
    // The classic float trap: 0.1 + 0.2 style inputs stay exact.
    ['0.29', 2, 29],
    ['1.15', 2, 115],
  ])('parses %j with %i decimals as %i', (input, digits, expected) => {
    expect(parseAmountToMinorUnits(input, digits)).toBe(expected);
  });

  it.each([
    ['', 2],
    ['.', 2],
    ['.5', 2],
    ['abc', 2],
    ['-5', 2],
    ['+5', 2],
    ['5.123', 2],
    ['5.5', 0],
    ['1e3', 2],
    ['1,000', 2],
    ['5,50', 2],
    ['5 000', 2],
    ['Infinity', 2],
    ['NaN', 2],
    ['0x10', 2],
    ['５', 2], // full-width digit
    ['99999999999999999999', 2],
  ])('rejects %j with %i decimals', (input, digits) => {
    expect(parseAmountToMinorUnits(input, digits)).toBeUndefined();
  });

  it('accepts the largest safe integer and rejects one above it', () => {
    expect(parseAmountToMinorUnits('90071992547409.91', 2)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseAmountToMinorUnits('90071992547409.92', 2)).toBeUndefined();
  });
});

describe('formatMinorUnits', () => {
  it.each([
    [550, 2, '5.50'],
    [1, 2, '0.01'],
    [0, 2, '0.00'],
    [100000, 2, '1000.00'],
    [7, 0, '7'],
    [1234, 3, '1.234'],
    [5, 3, '0.005'],
  ])('formats %i with %i decimals as %j', (minor, digits, expected) => {
    expect(formatMinorUnits(minor, digits)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects %d', (minor) => {
    expect(() => formatMinorUnits(minor, 2)).toThrow(RangeError);
  });

  it('round-trips with parseAmountToMinorUnits', () => {
    for (const minor of [0, 1, 9, 10, 99, 100, 101, 12345, 999999]) {
      expect(parseAmountToMinorUnits(formatMinorUnits(minor, 2), 2)).toBe(minor);
    }
  });
});

describe('formatMoneyForDisplay', () => {
  it('formats with symbol and grouping', () => {
    expect(formatMoneyForDisplay(123456, 'usd')).toBe('$1,234.56');
  });

  it('respects zero-decimal currencies', () => {
    expect(formatMoneyForDisplay(500, 'jpy')).toBe('¥500');
  });
});
