/**
 * Read-only queries for the public leaderboard.
 *
 * A donation counts when it is paid (its alert was triggered), was not later
 * refunded or failed, is in the configured currency, and the donor did not opt
 * out. Names are grouped by their case-insensitive key; "Anonymous" is never
 * ranked because it is not one person.
 *
 * Names are unverified: two people using one name share a row, and anyone can
 * donate under an existing name. Accepted when the feature was agreed.
 */
import type { Database } from '../database.ts';
import { anonymousDonorName } from './donation-form.ts';
import { donorNameKey } from './donor-name-key.ts';

export type TopDonor = {
  /** The spelling from the donor's most recent donation. */
  readonly donorName: string;
  readonly totalMinor: number;
  readonly donationCount: number;
  /** ISO timestamp of the most recent counted donation. */
  readonly lastDonatedAt: string;
};

export type RecentDonation = {
  readonly donorName: string;
  readonly amountMinor: number;
  /** ISO timestamp of when the payment counted. */
  readonly donatedAt: string;
};

export type LeaderboardQueries = ReturnType<typeof createLeaderboardQueries>;

/** The rows a public list may show; the same rule in both queries. */
const listedPaidDonations = `
  show_on_leaderboard = 1
  AND alert_triggered_at IS NOT NULL
  AND status NOT IN ('refunded', 'failed')
  AND currency = :currency
`;

/**
 * Bounded by LIMIT, and the partial index on donor_name_key covers the filter.
 * Ties go to whoever reached the total first, so ranks are stable. Exported so
 * a test can check the real query plan.
 */
export const topDonorsSql = `
    SELECT
      donor_name_key,
      SUM(amount_minor) AS total_minor,
      COUNT(*) AS donation_count,
      MAX(alert_triggered_at) AS last_donated_at,
      (
        SELECT latest.donor_name FROM donations AS latest
        WHERE latest.donor_name_key = grouped.donor_name_key AND ${listedPaidDonations}
        ORDER BY latest.id DESC LIMIT 1
      ) AS donor_name
    FROM donations AS grouped
    WHERE ${listedPaidDonations} AND donor_name_key <> :anonymousKey
    GROUP BY donor_name_key
    ORDER BY total_minor DESC, last_donated_at ASC
    LIMIT :limit
`;

/** Newest first through the donations_recent index. Exported for the plan test. */
export const recentSql = `
    SELECT donor_name, amount_minor, alert_triggered_at
    FROM donations
    WHERE ${listedPaidDonations}
    ORDER BY alert_triggered_at DESC
    LIMIT :limit
`;

export function createLeaderboardQueries(database: Database) {
  const topDonorsStatement = database.prepare(topDonorsSql);
  const recentStatement = database.prepare(recentSql);

  return {
    /** Highest totals per donor name, at most `limit` rows. */
    topDonors(currency: string, limit: number): TopDonor[] {
      const rows = topDonorsStatement.all({
        currency,
        anonymousKey: donorNameKey(anonymousDonorName),
        limit: clampLimit(limit),
      }) as {
        donor_name: string;
        total_minor: number;
        donation_count: number;
        last_donated_at: string;
      }[];
      return rows.map((row) => ({
        donorName: row.donor_name,
        totalMinor: row.total_minor,
        donationCount: row.donation_count,
        lastDonatedAt: row.last_donated_at,
      }));
    },

    /** Latest counted donations, newest first, at most `limit` rows. Anonymous included. */
    recent(currency: string, limit: number): RecentDonation[] {
      const rows = recentStatement.all({ currency, limit: clampLimit(limit) }) as {
        donor_name: string;
        amount_minor: number;
        alert_triggered_at: string;
      }[];
      return rows.map((row) => ({
        donorName: row.donor_name,
        amountMinor: row.amount_minor,
        donatedAt: row.alert_triggered_at,
      }));
    },
  };
}

/** Public endpoints must never run an unbounded query. */
function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
