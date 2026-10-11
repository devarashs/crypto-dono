import { describe, expect, it } from 'vitest';
import { donationStatuses, type DonationStatus } from '../src/donations/donation-repository.ts';
import {
  alertThresholdStatuses,
  isForwardTransition,
  reachesAlertThreshold,
} from '../src/donations/payment-status.ts';

describe('isForwardTransition', () => {
  it.each<[DonationStatus, DonationStatus]>([
    ['created', 'waiting'],
    ['waiting', 'confirming'],
    ['confirming', 'confirmed'],
    ['confirmed', 'sending'],
    ['sending', 'finished'],
    ['confirming', 'partially_paid'],
    ['waiting', 'expired'],
    ['confirming', 'failed'],
    ['finished', 'refunded'],
    ['confirming', 'confirming'],
  ])('allows %s → %s', (current, next) => {
    expect(isForwardTransition(current, next)).toBe(true);
  });

  it.each<[DonationStatus, DonationStatus]>([
    ['finished', 'confirming'],
    ['finished', 'waiting'],
    ['confirmed', 'confirming'],
    ['sending', 'confirmed'],
    ['refunded', 'finished'],
    ['expired', 'waiting'],
    ['waiting', 'created'],
  ])('refuses the backwards step %s → %s', (current, next) => {
    expect(isForwardTransition(current, next)).toBe(false);
  });
});

describe('reachesAlertThreshold', () => {
  const expectations: Record<(typeof alertThresholdStatuses)[number], DonationStatus[]> = {
    confirming: ['confirming', 'confirmed', 'sending', 'finished', 'partially_paid'],
    confirmed: ['confirmed', 'sending', 'finished', 'partially_paid'],
    finished: ['finished', 'partially_paid'],
  };

  for (const threshold of alertThresholdStatuses) {
    it(`with threshold ${threshold}, alerts on exactly ${expectations[threshold].join(', ')}`, () => {
      const alerting = donationStatuses.filter((status) => reachesAlertThreshold(status, threshold));
      expect(alerting.sort()).toEqual([...expectations[threshold]].sort());
    });
  }

  it.each<DonationStatus>(['failed', 'expired', 'refunded', 'created', 'waiting'])(
    'never alerts on %s',
    (status) => {
      for (const threshold of alertThresholdStatuses) expect(reachesAlertThreshold(status, threshold)).toBe(false);
    },
  );
});
