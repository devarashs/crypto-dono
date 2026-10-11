import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/database.ts';
import {
  createDonationRepository,
  type DonationRepository,
} from '../src/donations/donation-repository.ts';

const fixedNow = new Date('2026-10-11T12:00:00.000Z');
const newDonation = { donorName: 'Ann', message: 'gg', amountMinor: 500, currency: 'usd' };

describe('donation repository', () => {
  let database: Database;
  let repository: DonationRepository;
  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = createDonationRepository(database, () => fixedNow);
  });

  it('creates a donation in the created state with timestamps from the clock', () => {
    const donation = repository.create(newDonation);
    expect(donation).toMatchObject({
      ...newDonation,
      status: 'created',
      nowpaymentsInvoiceId: null,
      nowpaymentsPaymentId: null,
      payCurrency: null,
      actuallyPaid: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
    });
  });

  it('gives each donation a distinct, URL-safe 128-bit public id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => repository.create(newDonation).publicId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('finds a donation by public id', () => {
    const created = repository.create(newDonation);
    expect(repository.findByPublicId(created.publicId)).toEqual(created);
  });

  it('returns undefined for an unknown public id', () => {
    expect(repository.findByPublicId('missing')).toBeUndefined();
  });

  it('stores names and messages with unicode and SQL metacharacters verbatim', () => {
    const tricky = { ...newDonation, donorName: "Ro'bert); DROP TABLE donations;--", message: 'héllo 👋 世界' };
    const created = repository.create(tricky);
    expect(repository.findByPublicId(created.publicId)).toMatchObject(tricky);
  });

  it.each([0, -100])('rejects a non-positive amount (%i)', (amountMinor) => {
    expect(() => repository.create({ ...newDonation, amountMinor })).toThrow(/CHECK constraint/);
  });

  it('rejects a non-integer amount', () => {
    expect(() => repository.create({ ...newDonation, amountMinor: 1.5 })).toThrow();
  });

  it('records the invoice id and bumps updated_at', () => {
    const created = repository.create(newDonation);
    const later = new Date('2026-10-11T12:05:00.000Z');
    const laterRepository = createDonationRepository(database, () => later);
    const updated = laterRepository.setInvoiceId(created.publicId, 'inv_123');
    expect(updated).toMatchObject({
      nowpaymentsInvoiceId: 'inv_123',
      createdAt: fixedNow.toISOString(),
      updatedAt: later.toISOString(),
    });
  });

  it('returns undefined when setting an invoice on an unknown donation', () => {
    expect(repository.setInvoiceId('missing', 'inv_123')).toBeUndefined();
  });
});
