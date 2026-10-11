/**
 * Persistence for donations. The only module that writes SQL against the
 * donations table; everything else goes through these functions.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from '../database.ts';

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
  readonly createdAt: string;
  readonly updatedAt: string;
};

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
