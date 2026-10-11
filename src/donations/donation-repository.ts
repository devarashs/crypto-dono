/**
 * Persistence for donations. The only module that writes SQL against the
 * donations table; everything else goes through these functions.
 */
import { randomBytes } from 'node:crypto';
import { runInTransaction, type Database } from '../database.ts';
import { isForwardTransition, reachesAlertThreshold, type AlertThresholdStatus } from './payment-status.ts';

/** Every status NOWPayments reports, plus `created` for "invoice not yet made". */
export const donationStatuses = [
  'created',
  'waiting',
  'confirming',
  'confirmed',
  'sending',
  'partially_paid',
  'finished',
  'failed',
  'refunded',
  'expired',
] as const;
export type DonationStatus = (typeof donationStatuses)[number];

export type Donation = {
  readonly id: number;
  readonly publicId: string;
  readonly donorName: string;
  readonly message: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: DonationStatus;
  readonly nowpaymentsInvoiceId: string | null;
  readonly nowpaymentsPaymentId: string | null;
  readonly payCurrency: string | null;
  readonly actuallyPaid: string | null;
  /** When the alert was triggered; `null` until the payment crossed the threshold. */
  readonly alertTriggeredAt: string | null;
  /** When an overlay reported the alert as shown; `null` while it is pending. */
  readonly alertShownAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** The payment facts carried by one NOWPayments IPN. */
export type PaymentUpdate = {
  readonly status: DonationStatus;
  readonly paymentId: string;
  readonly invoiceId: string | null;
  readonly payCurrency: string | null;
  readonly actuallyPaid: string | null;
};

export type PaymentUpdateResult =
  | { readonly outcome: 'unknown-donation' }
  /** The IPN names a different invoice than the one this donation created. */
  | { readonly outcome: 'invoice-mismatch'; readonly donation: Donation }
  /** Older than what is already recorded, e.g. a delayed retry. Nothing changed. */
  | { readonly outcome: 'stale'; readonly donation: Donation }
  | { readonly outcome: 'applied'; readonly donation: Donation; readonly alertTriggered: boolean };

export type NewDonation = {
  readonly donorName: string;
  readonly message: string;
  readonly amountMinor: number;
  readonly currency: string;
};

type DonationRow = {
  id: number;
  public_id: string;
  donor_name: string;
  message: string;
  amount_minor: number;
  currency: string;
  status: DonationStatus;
  nowpayments_invoice_id: string | null;
  nowpayments_payment_id: string | null;
  pay_currency: string | null;
  actually_paid: string | null;
  alert_triggered_at: string | null;
  alert_shown_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DonationRepository = ReturnType<typeof createDonationRepository>;

/**
 * @param database Open, migrated connection.
 * @param now Clock, injected so tests control timestamps.
 */
export function createDonationRepository(database: Database, now: () => Date = () => new Date()) {
  const insertStatement = database.prepare(`
    INSERT INTO donations (public_id, donor_name, message, amount_minor, currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  const findByPublicIdStatement = database.prepare('SELECT * FROM donations WHERE public_id = ?');
  const applyPaymentStatement = database.prepare(`
    UPDATE donations
    SET status = ?, nowpayments_payment_id = ?, pay_currency = ?, actually_paid = ?,
        alert_triggered_at = COALESCE(alert_triggered_at, ?), updated_at = ?
    WHERE public_id = ?
    RETURNING *
  `);
  const listPendingAlertsStatement = database.prepare(`
    SELECT * FROM donations
    WHERE alert_triggered_at IS NOT NULL AND alert_shown_at IS NULL AND alert_triggered_at >= ?
    ORDER BY alert_triggered_at, id
  `);
  const markAlertShownStatement = database.prepare(`
    UPDATE donations SET alert_shown_at = ?, updated_at = ?
    WHERE public_id = ? AND alert_triggered_at IS NOT NULL AND alert_shown_at IS NULL
    RETURNING *
  `);
  const setInvoiceStatement = database.prepare(`
    UPDATE donations SET nowpayments_invoice_id = ?, updated_at = ?
    WHERE public_id = ?
    RETURNING *
  `);

  return {
    /**
     * Records a donation before any payment exists, so the donor's name and
     * message are safe even if they abandon checkout.
     *
     * @throws If the row violates a constraint (e.g. a non-positive amount).
     */
    create(donation: NewDonation): Donation {
      const timestamp = now().toISOString();
      const row = insertStatement.get(
        generatePublicId(),
        donation.donorName,
        donation.message,
        donation.amountMinor,
        donation.currency,
        timestamp,
        timestamp,
      ) as DonationRow;
      return toDonation(row);
    },

    /** @returns The donation, or `undefined` if no donation has that id. */
    findByPublicId(publicId: string): Donation | undefined {
      const row = findByPublicIdStatement.get(publicId) as DonationRow | undefined;
      return row === undefined ? undefined : toDonation(row);
    },

    /**
     * Records a payment status change and decides, atomically, whether it
     * triggers the donation's alert.
     *
     * Idempotent: replaying the same IPN, or any IPN after the alert fired,
     * never returns `alertTriggered: true` a second time. Updates that would move
     * the status backwards are ignored.
     *
     * @param publicId The donation's public id, which NOWPayments echoes as `order_id`.
     * @param threshold The status from which a payment earns its alert.
     */
    applyPaymentUpdate(
      publicId: string,
      update: PaymentUpdate,
      threshold: AlertThresholdStatus,
    ): PaymentUpdateResult {
      return runInTransaction(database, () => {
        const row = findByPublicIdStatement.get(publicId) as DonationRow | undefined;
        if (row === undefined) return { outcome: 'unknown-donation' } as const;
        const current = toDonation(row);
        if (
          current.nowpaymentsInvoiceId !== null &&
          update.invoiceId !== null &&
          current.nowpaymentsInvoiceId !== update.invoiceId
        ) {
          return { outcome: 'invoice-mismatch', donation: current } as const;
        }
        if (!isForwardTransition(current.status, update.status)) {
          return { outcome: 'stale', donation: current } as const;
        }

        const timestamp = now().toISOString();
        const alertTriggered =
          current.alertTriggeredAt === null && reachesAlertThreshold(update.status, threshold);
        const updatedRow = applyPaymentStatement.get(
          update.status,
          update.paymentId,
          update.payCurrency,
          update.actuallyPaid,
          alertTriggered ? timestamp : null,
          timestamp,
          publicId,
        ) as DonationRow;
        return { outcome: 'applied', donation: toDonation(updatedRow), alertTriggered } as const;
      });
    },

    /**
     * Alerts that were triggered but never reported as shown, oldest first.
     *
     * @param triggeredSince ISO timestamp; older pending alerts are left out so an
     *   overlay opened after a long gap does not replay a backlog of stale alerts.
     */
    listPendingAlerts(triggeredSince: string): Donation[] {
      return (listPendingAlertsStatement.all(triggeredSince) as DonationRow[]).map(toDonation);
    },

    /**
     * Records that an overlay finished showing the alert.
     *
     * @returns True the first time; false if the alert was already marked, was
     *   never triggered, or the id is unknown. Safe to call repeatedly.
     */
    markAlertShown(publicId: string): boolean {
      const timestamp = now().toISOString();
      return markAlertShownStatement.get(timestamp, timestamp, publicId) !== undefined;
    },

    /** @returns The updated donation, or `undefined` if no donation has that id. */
    setInvoiceId(publicId: string, invoiceId: string): Donation | undefined {
      const row = setInvoiceStatement.get(invoiceId, now().toISOString(), publicId) as
        | DonationRow
        | undefined;
      return row === undefined ? undefined : toDonation(row);
    },
  };
}

/** 128 random bits, URL-safe. Unguessable, so a donation id grants nothing. */
function generatePublicId(): string {
  return randomBytes(16).toString('base64url');
}

function toDonation(row: DonationRow): Donation {
  return {
    id: row.id,
    publicId: row.public_id,
    donorName: row.donor_name,
    message: row.message,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    nowpaymentsInvoiceId: row.nowpayments_invoice_id,
    nowpaymentsPaymentId: row.nowpayments_payment_id,
    payCurrency: row.pay_currency,
    actuallyPaid: row.actually_paid,
    alertTriggeredAt: row.alert_triggered_at,
    alertShownAt: row.alert_shown_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
