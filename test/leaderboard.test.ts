import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/database.ts';
import { createDonationRepository, type DonationRepository, type DonationStatus } from '../src/donations/donation-repository.ts';
import {
  biggestSql,
  createLeaderboardQueries,
  recentSql,
  topDonorsSql,
  type LeaderboardQueries,
} from '../src/donations/leaderboard.ts';

describe('leaderboard queries', () => {
  let database: Database;
  let donations: DonationRepository;
  let leaderboard: LeaderboardQueries;
  let clock: Date;

  beforeEach(() => {
    database = openDatabase(':memory:');
    clock = new Date('2026-10-01T00:00:00.000Z');
    donations = createDonationRepository(database, () => clock);
    leaderboard = createLeaderboardQueries(database);
  });

  /** Records a donation and, unless `status` says otherwise, marks it paid. */
  function donate(
    donorName: string,
    amountMinor: number,
    options: { status?: DonationStatus | 'unpaid'; listed?: boolean; currency?: string; at?: string } = {},
  ): string {
    if (options.at !== undefined) clock = new Date(options.at);
    else clock = new Date(clock.getTime() + 60_000);
    const { publicId } = donations.create({
      donorName,
      message: '',
      amountMinor,
      currency: options.currency ?? 'usd',
      showOnLeaderboard: options.listed ?? true,
    });
    if (options.status === 'unpaid') return publicId;
    donations.applyPaymentUpdate(
      publicId,
      { status: 'finished', paymentId: `p-${publicId}`, invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
      'confirmed',
    );
    if (options.status !== undefined && options.status !== 'finished') {
      donations.applyPaymentUpdate(
        publicId,
        { status: options.status, paymentId: `p-${publicId}`, invoiceId: null, payCurrency: 'ltc', actuallyPaid: '1' },
        'confirmed',
      );
    }
    return publicId;
  }

  describe('topDonors', () => {
    it('sums donations per name, highest first', () => {
      donate('Ann', 500);
      donate('Bo', 2000);
      donate('Ann', 1000);
      expect(leaderboard.topDonors('usd', 100)).toMatchObject([
        { donorName: 'Bo', totalMinor: 2000, donationCount: 1 },
        { donorName: 'Ann', totalMinor: 1500, donationCount: 2 },
      ]);
    });

    it('groups names regardless of case and full-width letters, showing the latest spelling', () => {
      donate('ann', 500);
      donate('ＡＮＮ', 500);
      donate('Ann', 500);
      expect(leaderboard.topDonors('usd', 100)).toEqual([
        expect.objectContaining({ donorName: 'Ann', totalMinor: 1500, donationCount: 3 }),
      ]);
    });

    it('never ranks Anonymous, in any case', () => {
      donate('Anonymous', 9000);
      donate('anonymous', 9000);
      donate('Ann', 100);
      expect(leaderboard.topDonors('usd', 100).map((row) => row.donorName)).toEqual(['Ann']);
    });

    it('leaves out unpaid, refunded, failed, opted-out and other-currency donations', () => {
      donate('Unpaid', 9000, { status: 'unpaid' });
      donate('Refunded', 9000, { status: 'refunded' });
      donate('Hidden', 9000, { listed: false });
      donate('Euro', 9000, { currency: 'eur' });
      donate('Counted', 100);
      expect(leaderboard.topDonors('usd', 100).map((row) => row.donorName)).toEqual(['Counted']);
    });

    it('does not count an opted-out donation toward the same name', () => {
      donate('Ann', 500);
      donate('Ann', 5000, { listed: false });
      expect(leaderboard.topDonors('usd', 100)).toMatchObject([{ donorName: 'Ann', totalMinor: 500, donationCount: 1 }]);
    });

    it('ranks a tie by who reached the total first', () => {
      donate('Late', 500, { at: '2026-10-05T00:00:00.000Z' });
      donate('Early', 500, { at: '2026-10-02T00:00:00.000Z' });
      expect(leaderboard.topDonors('usd', 100).map((row) => row.donorName)).toEqual(['Early', 'Late']);
    });

    it('returns at most the limit, clamped to 100', () => {
      for (let index = 0; index < 105; index += 1) donate(`Donor ${index}`, 100 + index);
      expect(leaderboard.topDonors('usd', 3).map((row) => row.donorName)).toEqual(['Donor 104', 'Donor 103', 'Donor 102']);
      expect(leaderboard.topDonors('usd', 10_000)).toHaveLength(100);
    });

    it('is empty with no donations', () => {
      expect(leaderboard.topDonors('usd', 100)).toEqual([]);
    });
  });

  describe('biggest', () => {
    it('lists single donations by size, not totals per name, leaving Anonymous out', () => {
      donate('Ann', 500);
      donate('Ann', 600);
      donate('Anonymous', 2000);
      donate('anonymous', 1500);
      donate('Bo', 900);
      expect(leaderboard.biggest('usd', 10)).toEqual([
        { donorName: 'Bo', amountMinor: 900 },
        { donorName: 'Ann', amountMinor: 600 },
        { donorName: 'Ann', amountMinor: 500 },
      ]);
    });

    it('applies the same rules as the public leaderboard', () => {
      donate('Unpaid', 9000, { status: 'unpaid' });
      donate('Refunded', 9000, { status: 'refunded' });
      donate('Hidden', 9000, { listed: false });
      donate('Euro', 9000, { currency: 'eur' });
      donate('Counted', 100);
      expect(leaderboard.biggest('usd', 10).map((row) => row.donorName)).toEqual(['Counted']);
    });

    it('keeps the earlier donation ahead on a tie, and respects the limit', () => {
      donate('First', 500, { at: '2026-10-02T00:00:00.000Z' });
      donate('Second', 500, { at: '2026-10-03T00:00:00.000Z' });
      donate('Small', 100, { at: '2026-10-04T00:00:00.000Z' });
      expect(leaderboard.biggest('usd', 2).map((row) => row.donorName)).toEqual(['First', 'Second']);
    });

    it('reads the top straight off an index, without sorting', () => {
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${biggestSql}`)
        .all({ currency: 'usd', limit: 10 }) as { detail: string }[];
      const details = plan.map((step) => step.detail).join('\n');
      expect(details).toContain('donations_biggest');
      expect(details).not.toContain('TEMP B-TREE');
    });
  });

  describe('recent', () => {
    it('lists counted donations newest first, leaving Anonymous out', () => {
      donate('Ann', 500);
      donate('Anonymous', 700);
      donate('Hidden', 900, { listed: false });
      donate('Bo', 300);
      expect(leaderboard.recent('usd', 10)).toMatchObject([
        { donorName: 'Bo', amountMinor: 300 },
        { donorName: 'Ann', amountMinor: 500 },
      ]);
    });

    it('respects the limit', () => {
      for (let index = 0; index < 5; index += 1) donate(`D${index}`, 100);
      expect(leaderboard.recent('usd', 2).map((row) => row.donorName)).toEqual(['D4', 'D3']);
    });
  });

  it('reads recent donations through an index, without sorting the table', () => {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${recentSql}`)
      .all({ currency: 'usd', limit: 25 }) as { detail: string }[];
    const details = plan.map((step) => step.detail).join('\n');
    expect(details).toContain('donations_recent');
    expect(details).not.toContain('TEMP B-TREE');
  });

  it('uses the partial index for the top-donor grouping', () => {
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${topDonorsSql}`)
      .all({ currency: 'usd', anonymousKey: 'anonymous', limit: 100 }) as { detail: string }[];
    expect(plan.map((step) => step.detail).join('\n')).toContain('donations_leaderboard');
  });
});
