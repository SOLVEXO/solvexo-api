/* eslint-disable prettier/prettier */
import {
  type InvoiceRow,
  type LedgerRow,
  type PlanRules,
  netUSD,
  payableAt,
  percentApplies,
  percentFor,
  plannedRows,
  statement,
} from './commission.util';

const plan = (over: Partial<PlanRules> = {}): PlanRules => ({
  bountyPKR: 5000,
  percent: 20,
  percentMonths: 12,
  tiers: [],
  holdDays: 14,
  ...over,
});
const inv = (
  id: string,
  paidAt: string,
  over: Partial<InvoiceRow> = {},
): InvoiceRow => ({
  id,
  sellerId: 's1',
  storeId: 'st1',
  invoiceNumber: `INV-${id}`,
  amountUSD: 11.8,
  subtotalUSD: 10,
  taxAmountUSD: 1.8,
  refundedAmountUSD: 0,
  status: 'paid',
  paidAt: new Date(paidAt),
  ...over,
});
const run = (
  invoices: InvoiceRow[],
  existing: LedgerRow[] = [],
  p = plan(),
  effectiveFrom = new Date('2026-01-01'),
) =>
  plannedRows({
    plan: p,
    invoices,
    existing,
    effectiveFrom,
    payingNow: 1,
    rateFor: () => 280,
    existingRate: () => null,
  });
const asLedger = (rows: ReturnType<typeof run>): LedgerRow[] =>
  rows.map((r) => ({
    key: r.key,
    type: r.type,
    invoiceId: r.invoiceId,
    amountPKR: r.amountPKR,
  }));

describe('commission rules', () => {
  it('earns on what Solvexo kept: before tax, after refunds', () => {
    expect(netUSD(inv('a', '2026-03-01'))).toBe(10);
    expect(
      netUSD(
        inv('a', '2026-03-01', {
          subtotalUSD: null,
          amountUSD: 12,
          taxAmountUSD: 2,
        }),
      ),
    ).toBe(10);
    expect(
      netUSD(
        inv('a', '2026-03-01', {
          status: 'partially_refunded',
          refundedAmountUSD: 5.9,
        }),
      ),
    ).toBe(5);
    expect(
      netUSD(
        inv('a', '2026-03-01', { status: 'refunded', refundedAmountUSD: 11.8 }),
      ),
    ).toBe(0);
  });

  it('raises the percentage at volume tiers, and stops it after the set months', () => {
    const p = plan({
      tiers: [
        { minPaying: 10, percent: 25 },
        { minPaying: 25, percent: 30 },
      ],
    });
    expect([percentFor(p, 3), percentFor(p, 10), percentFor(p, 40)]).toEqual([
      20, 25, 30,
    ]);
    expect(
      percentApplies(p, new Date('2026-01-15'), new Date('2026-12-31')),
    ).toBe(true);
    expect(
      percentApplies(p, new Date('2026-01-15'), new Date('2027-01-15')),
    ).toBe(false);
    expect(
      percentApplies(
        plan({ percentMonths: null }),
        new Date('2020-01-01'),
        new Date('2030-01-01'),
      ),
    ).toBe(true);
    expect(
      percentApplies(
        plan({ percent: 0 }),
        new Date('2026-01-01'),
        new Date('2026-01-02'),
      ),
    ).toBe(false);
  });

  it('pays a bounty on the first payment and a percentage of each, once', () => {
    const invoices = [inv('a', '2026-02-01'), inv('b', '2026-03-01')];
    const first = run(invoices);
    expect(first.map((r) => [r.key, r.amountPKR])).toEqual([
      ['bounty:s1', 5000],
      ['pct:a', 560],
      ['pct:b', 560],
    ]);
    expect(run(invoices, asLedger(first))).toEqual([]);
  });

  it('adds a correcting row when a paid invoice is refunded, and takes the bounty back on a full refund of the first payment', () => {
    const invoices = [inv('a', '2026-02-01')];
    const ledger = asLedger(run(invoices));
    const refunded = run(
      [inv('a', '2026-02-01', { status: 'refunded', refundedAmountUSD: 11.8 })],
      ledger,
    );
    expect(refunded.map((r) => [r.key, r.amountPKR])).toEqual([
      ['bounty:s1:adj:1', -5000],
      ['pct:a:adj:1', -560],
    ]);
    expect(
      run(
        [
          inv('a', '2026-02-01', {
            status: 'refunded',
            refundedAmountUSD: 11.8,
          }),
        ],
        [...ledger, ...asLedger(refunded)],
      ),
    ).toEqual([]);
  });

  it('ignores payments made before the referral began', () => {
    expect(
      run([inv('a', '2025-12-01'), inv('b', '2026-02-01')]).map((r) => r.key),
    ).toEqual(['pct:b']);
  });

  it('holds earnings for the refund window, and builds a monthly statement', () => {
    expect(payableAt(new Date('2026-03-01T00:00:00Z'), 14).toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
    const s = statement(
      [
        { amountPKR: 5000, earnedAt: new Date('2026-02-10'), status: 'paid' },
        { amountPKR: 560, earnedAt: new Date('2026-03-05'), status: 'payable' },
        { amountPKR: 999, earnedAt: new Date('2026-03-06'), status: 'void' },
      ],
      [
        { amountPKR: 3000, paidAt: new Date('2026-02-28') },
        { amountPKR: 2000, paidAt: new Date('2026-03-20') },
      ],
      new Date('2026-03-01'),
      new Date('2026-04-01'),
    );
    expect(s).toEqual({
      openingPKR: 2000,
      earnedPKR: 560,
      paidPKR: 2000,
      closingPKR: 560,
    });
  });
});
