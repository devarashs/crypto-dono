import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../src/database.ts';
import {
  createDonationRepository,
  type DonationRepository,
  type DonationStatus,
  type PaymentUpdate,
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

  it('starts with no alert triggered', () => {
    expect(repository.create(newDonation).alertTriggeredAt).toBeNull();
  });
});

describe('applyPaymentUpdate', () => {
  let repository: DonationRepository;
  let publicId: string;
  const payment = (status: DonationStatus, overrides: Partial<PaymentUpdate> = {}): PaymentUpdate => ({
    status,
    paymentId: 'pay_1',
    invoiceId: 'inv_1',
    payCurrency: 'ltc',
    actuallyPaid: '0.0712',
    ...overrides,
  });

  beforeEach(() => {
    repository = createDonationRepository(openDatabase(':memory:'), () => fixedNow);
    publicId = repository.create(newDonation).publicId;
    repository.setInvoiceId(publicId, 'inv_1');
  });

  it('records the payment fields without alerting below the threshold', () => {
    const result = repository.applyPaymentUpdate(publicId, payment('waiting'), 'confirmed');
    expect(result).toMatchObject({
      outcome: 'applied',
      alertTriggered: false,
      donation: {
        status: 'waiting',
        nowpaymentsPaymentId: 'pay_1',
        payCurrency: 'ltc',
        actuallyPaid: '0.0712',
        alertTriggeredAt: null,
      },
    });
  });

  it('triggers the alert once, when the threshold is reached', () => {
    repository.applyPaymentUpdate(publicId, payment('waiting'), 'confirmed');
    repository.applyPaymentUpdate(publicId, payment('confirming'), 'confirmed');
    const crossing = repository.applyPaymentUpdate(publicId, payment('confirmed'), 'confirmed');
    expect(crossing).toMatchObject({
      outcome: 'applied',
      alertTriggered: true,
      donation: { alertTriggeredAt: fixedNow.toISOString() },
    });
    for (const later of ['sending', 'finished'] as const) {
      expect(repository.applyPaymentUpdate(publicId, payment(later), 'confirmed')).toMatchObject({
        outcome: 'applied',
        alertTriggered: false,
      });
    }
  });

  it('triggers on the first update past the threshold even if intermediate statuses were skipped', () => {
    expect(repository.applyPaymentUpdate(publicId, payment('finished'), 'confirming')).toMatchObject({
      alertTriggered: true,
    });
  });

  it('does not alert twice when the same IPN is delivered again', () => {
    const first = repository.applyPaymentUpdate(publicId, payment('finished'), 'finished');
    const retry = repository.applyPaymentUpdate(publicId, payment('finished'), 'finished');
    expect(first).toMatchObject({ alertTriggered: true });
    expect(retry).toMatchObject({ outcome: 'applied', alertTriggered: false });
  });

  it('ignores a delayed update that would move the status backwards', () => {
    repository.applyPaymentUpdate(publicId, payment('finished'), 'confirmed');
    const result = repository.applyPaymentUpdate(publicId, payment('confirming', { actuallyPaid: '0' }), 'confirmed');
    expect(result).toMatchObject({ outcome: 'stale', donation: { status: 'finished', actuallyPaid: '0.0712' } });
  });

  it('never alerts on a failed or expired payment', () => {
    expect(repository.applyPaymentUpdate(publicId, payment('expired'), 'confirming')).toMatchObject({
      outcome: 'applied',
      alertTriggered: false,
      donation: { status: 'expired' },
    });
  });

  it('keeps the alert timestamp when a payment is later refunded', () => {
    repository.applyPaymentUpdate(publicId, payment('finished'), 'confirming');
    const refunded = repository.applyPaymentUpdate(publicId, payment('refunded'), 'confirming');
    expect(refunded).toMatchObject({
      alertTriggered: false,
      donation: { status: 'refunded', alertTriggeredAt: fixedNow.toISOString() },
    });
  });

  it('reports an unknown donation without writing anything', () => {
    expect(repository.applyPaymentUpdate('nope', payment('finished'), 'confirmed')).toEqual({
      outcome: 'unknown-donation',
    });
  });

  it('refuses an IPN for a different invoice', () => {
    const result = repository.applyPaymentUpdate(publicId, payment('finished', { invoiceId: 'inv_other' }), 'confirmed');
    expect(result).toMatchObject({ outcome: 'invoice-mismatch', donation: { status: 'created' } });
  });

  it('accepts an IPN without an invoice id', () => {
    expect(
      repository.applyPaymentUpdate(publicId, payment('confirming', { invoiceId: null }), 'confirming'),
    ).toMatchObject({ outcome: 'applied', alertTriggered: true });
  });

  it('records a new payment id when the donor retries with another coin', () => {
    repository.applyPaymentUpdate(publicId, payment('waiting'), 'confirmed');
    const retried = repository.applyPaymentUpdate(
      publicId,
      payment('confirming', { paymentId: 'pay_2', payCurrency: 'trx' }),
      'confirmed',
    );
    expect(retried).toMatchObject({ donation: { nowpaymentsPaymentId: 'pay_2', payCurrency: 'trx' } });
  });
});
