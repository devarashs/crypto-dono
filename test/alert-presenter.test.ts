import { describe, expect, it } from 'vitest';
import {
  createAlertPresenter,
  donationToAlertSource,
  type AlertFilterRules,
  type AlertSource,
} from '../src/alerts/alert-presenter.ts';
import type { Donation } from '../src/donations/donation-repository.ts';

const noFilters: AlertFilterRules = {
  bannedWords: [],
  messageMinAmountMinor: 0,
  speechMinAmountMinor: 0,
  speechTemplate: '{name} donated {amount}. {message}',
};

const source: AlertSource = { id: 'd1', donorName: 'Ann', message: 'love the stream', amountMinor: 500, currency: 'usd' };

describe('createAlertPresenter', () => {
  it('passes everything through when no filters are set', () => {
    expect(createAlertPresenter(noFilters)(source)).toEqual({
      alert: { id: 'd1', donorName: 'Ann', message: 'love the stream', amount: '$5.00', speak: true },
      speechText: 'Ann donated $5.00. love the stream',
    });
  });

  it('does not speak when text-to-speech is off', () => {
    expect(createAlertPresenter({ ...noFilters, speechTemplate: null })(source)).toMatchObject({
      alert: { speak: false },
      speechText: null,
    });
  });

  describe('minimum amounts', () => {
    it('drops the message below MESSAGE_MIN_AMOUNT, from screen and speech', () => {
      const present = createAlertPresenter({ ...noFilters, messageMinAmountMinor: 501 });
      expect(present(source)).toEqual({
        alert: { id: 'd1', donorName: 'Ann', message: '', amount: '$5.00', speak: true },
        speechText: 'Ann donated $5.00.',
      });
    });

    it('keeps the message at exactly MESSAGE_MIN_AMOUNT', () => {
      expect(createAlertPresenter({ ...noFilters, messageMinAmountMinor: 500 })(source).alert.message).toBe(
        'love the stream',
      );
    });

    it('stays silent below TTS_MIN_AMOUNT but still shows the alert', () => {
      expect(createAlertPresenter({ ...noFilters, speechMinAmountMinor: 501 })(source)).toEqual({
        alert: { id: 'd1', donorName: 'Ann', message: 'love the stream', amount: '$5.00', speak: false },
        speechText: null,
      });
    });

    it('speaks at exactly TTS_MIN_AMOUNT', () => {
      expect(createAlertPresenter({ ...noFilters, speechMinAmountMinor: 500 })(source).alert.speak).toBe(true);
    });
  });

  describe('banned words', () => {
    const present = createAlertPresenter({ ...noFilters, bannedWords: ['darn', 'heck no', ' Fudge '] });

    it('masks banned words on screen, one star per character, in name and message', () => {
      const presented = present({ ...source, donorName: 'Darn Dave', message: 'darn it, HECK NO, fudge!' });
      expect(presented.alert.donorName).toBe('**** Dave');
      expect(presented.alert.message).toBe('**** it, *******, *****!');
    });

    it('drops banned words from speech instead of reading out stars', () => {
      const presented = present({ ...source, donorName: 'Darn Dave', message: 'darn it, fudge!' });
      expect(presented.speechText).toBe('Dave donated $5.00. it, !');
    });

    it('does not match inside longer words', () => {
      const presented = present({ ...source, message: 'darned fudgecake heckno' });
      expect(presented.alert.message).toBe('darned fudgecake heckno');
    });

    it('matches next to punctuation, digits excluded, and in any case', () => {
      expect(present({ ...source, message: '(DaRn)' }).alert.message).toBe('(****)');
      expect(present({ ...source, message: 'darn2' }).alert.message).toBe('darn2');
    });

    it('works with non-English words and counts stars by character', () => {
      const presentUnicode = createAlertPresenter({ ...noFilters, bannedWords: ['мат', 'çok'] });
      expect(presentUnicode({ ...source, message: 'это мат, çok kötü' }).alert.message).toBe('это ***, *** kötü');
      expect(presentUnicode({ ...source, message: 'математика' }).alert.message).toBe('математика');
    });

    it('prefers the longer phrase when one banned entry contains another', () => {
      const presentPhrases = createAlertPresenter({ ...noFilters, bannedWords: ['heck', 'heck no'] });
      expect(presentPhrases({ ...source, message: 'heck no' }).alert.message).toBe('*******');
    });

    it('treats regex characters in banned words literally', () => {
      const presentRegex = createAlertPresenter({ ...noFilters, bannedWords: ['a.b', '(x)'] });
      expect(presentRegex({ ...source, message: 'a.b axb' }).alert.message).toBe('*** axb');
    });

    it('ignores empty entries', () => {
      const presentEmpty = createAlertPresenter({ ...noFilters, bannedWords: ['', '   '] });
      expect(presentEmpty(source).alert.message).toBe('love the stream');
    });

    it('masks the name even when the message is hidden by the amount threshold', () => {
      const presentBoth = createAlertPresenter({ ...noFilters, bannedWords: ['darn'], messageMinAmountMinor: 10_000 });
      expect(presentBoth({ ...source, donorName: 'darn', message: 'darn' }).alert).toMatchObject({
        donorName: '****',
        message: '',
      });
    });
  });
});

describe('donationToAlertSource', () => {
  it('keeps only the fields an alert needs', () => {
    const donation = {
      publicId: 'p1',
      donorName: 'Ann',
      message: 'gg',
      amountMinor: 123456,
      currency: 'usd',
      nowpaymentsPaymentId: 'not for overlays',
    } as Donation;
    expect(donationToAlertSource(donation)).toEqual({
      id: 'p1',
      donorName: 'Ann',
      message: 'gg',
      amountMinor: 123456,
      currency: 'usd',
    });
  });
});
