/**
 * Ordering of payment statuses, and the rule for when a donation earns its alert.
 *
 * NOWPayments sends one IPN per status change and retries failed deliveries, so
 * callbacks can arrive late, twice, or out of order. It also skips statuses: a
 * real USDT (BSC) payment on 2026-10-11 went waiting → sending → finished with
 * no confirming or confirmed IPN at all. Statuses are therefore compared by
 * progress, never matched exactly, and never applied in arrival order.
 */
import type { DonationStatus } from './donation-repository.ts';

/** Statuses `ALERT_ON_STATUS` may name, in the order a healthy payment passes through them. */
export const alertThresholdStatuses = ['confirming', 'confirmed', 'finished'] as const;
export type AlertThresholdStatus = (typeof alertThresholdStatuses)[number];

/**
 * Progress through the payment lifecycle. A status update is applied only if it
 * does not move backwards, so a delayed `confirming` retry cannot overwrite
 * `finished`. Terminal outcomes rank above every in-flight status; `refunded`
 * ranks highest because it can follow `finished`.
 */
const progressRank: Readonly<Record<DonationStatus, number>> = {
  created: 0,
  waiting: 1,
  confirming: 2,
  confirmed: 3,
  sending: 4,
  partially_paid: 5,
  finished: 6,
  failed: 6,
  expired: 6,
  refunded: 7,
};

/** True if moving from `current` to `next` is not a step backwards. */
export function isForwardTransition(current: DonationStatus, next: DonationStatus): boolean {
  return progressRank[next] >= progressRank[current];
}

/**
 * True once a payment has progressed far enough to show its alert.
 *
 * `partially_paid` counts: the donor sent less than the invoice (usually
 * network fees), but NOWPayments only reports it once funds have arrived.
 * `failed`, `expired` and `refunded` never do.
 */
export function reachesAlertThreshold(status: DonationStatus, threshold: AlertThresholdStatus): boolean {
  if (status === 'failed' || status === 'expired' || status === 'refunded') return false;
  if (status === 'partially_paid') return true;
  return progressRank[status] >= progressRank[threshold];
}
