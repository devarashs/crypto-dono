import { describe, expect, it } from 'vitest';
import { headlineText, renderHeadline } from '../src/alerts/headline.ts';

describe('renderHeadline', () => {
  it('fills placeholders and highlights the chosen ones', () => {
    expect(renderHeadline('{name} donated {amount}', { name: 'Ann', amount: '$5.00' }, new Set(['amount']))).toEqual([
      { text: 'Ann donated ', emphasis: false },
      { text: '$5.00', emphasis: true },
    ]);
  });

  it('keeps text around and between placeholders, and repeats', () => {
    expect(
      headlineText(renderHeadline('Wow! {name} gifted {count} {subs}, thanks {name}!', { name: 'Bo', count: '5', subs: 'subs' })),
    ).toBe('Wow! Bo gifted 5 subs, thanks Bo!');
  });

  it('leaves unknown placeholders and stray braces literal', () => {
    expect(headlineText(renderHeadline('{name} {who} {amount', { name: 'Ann' }))).toBe('Ann {who} {amount');
  });

  it('does not treat inherited object keys as values', () => {
    expect(headlineText(renderHeadline('{constructor} {name}', { name: 'Ann' }))).toBe('{constructor} Ann');
  });

  it('keeps HTML-looking text as plain text parts', () => {
    expect(renderHeadline('<b>{name}</b>', { name: '<i>x</i>' })).toEqual([{ text: '<b><i>x</i></b>', emphasis: false }]);
  });

  it('handles adjacent placeholders and an empty value', () => {
    expect(renderHeadline('{count}{name}', { count: '3', name: '' }, new Set(['count']))).toEqual([{ text: '3', emphasis: true }]);
  });
});
