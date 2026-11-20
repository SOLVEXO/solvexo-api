/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import { BillingTimelineService } from './billing-timeline.service';

describe('BillingTimelineService', () => {
  const DAY = 86400000;
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
  const chain = (rows: any[]) => ({ sort: () => ({ lean: () => Promise.resolve(rows) }), select: () => ({ lean: () => Promise.resolve(rows) }), lean: () => Promise.resolve(rows) });

  function make(over: { sub?: any; invoices?: any[]; attempts?: any[]; addons?: any[]; fees?: any[]; owner?: string } = {}) {
    const sub = over.sub ?? {
      _id: 'sub1', storeId: 'st1', status: 'active', platformPlanId: 'pro', billingInterval: 'monthly', amountUSD: 79, creditBalanceUSD: 5,
      startedAt: iso(40), trialEndsAt: iso(37), nextBillingDate: new Date(Date.now() + 10 * DAY),
      planHistory: [
        { fromPlanId: null, fromPlanName: 'Trial', toPlanId: 'grow', toPlanName: 'Grow', proratedAmountUSD: 29, changedAt: iso(36), amountUSD: 29, interval: 'monthly' },
        { fromPlanId: 'grow', fromPlanName: 'Grow', toPlanId: 'pro', toPlanName: 'Pro', proratedAmountUSD: 60, changedAt: iso(10), amountUSD: 79, interval: 'monthly' },
      ],
    };
    const invoices = over.invoices ?? [
      { _id: 'i1', invoiceNumber: 'INV-1', platformPlanId: 'grow', type: 'initial', status: 'paid', amountUSD: 29, taxAmountUSD: 0, paidAt: iso(36), createdAt: iso(36), cardBrand: 'visa', cardLast4: '4242', stripeInvoiceId: 'in_x', providerChargeId: 'pi_1' },
      {
        _id: 'i2', invoiceNumber: 'INV-2', platformPlanId: 'pro', type: 'proration', status: 'partially_refunded', amountUSD: 60, taxAmountUSD: 6, paidAt: iso(10), createdAt: iso(10),
        cardBrand: 'visa', cardLast4: '4242', refundedAmountUSD: 10, refundedAt: iso(5), refundReason: 'goodwill',
        lineItems: [{ kind: 'plan', label: 'Pro plan (monthly)', amountUSD: 79 }, { kind: 'credit', label: 'Unused time on Grow', amountUSD: -25 }, { kind: 'tax', label: 'Tax', amountUSD: 6 }],
      },
    ];
    const attempts = over.attempts ?? [
      { _id: 'a1', outcome: 'failed', amountUSD: 79, failureReason: 'Your card has insufficient funds.', createdAt: iso(11), cardBrand: 'visa', cardLast4: '0341', providerChargeId: 'pi_f' },
      { _id: 'a2', outcome: 'success', amountUSD: 60, createdAt: iso(10) },
    ];
    const addons = over.addons ?? [{ _id: 'ad1', addonType: 'extra_staff_seat', priceUSD: 10, quantity: 1, status: 'active', createdAt: iso(20), charges: [{ amountUSD: 10, taxUSD: 0, chargedAt: iso(20) }] }];
    const fees = over.fees ?? [{ _id: 'f1', periodKey: '2026-10', amountUSD: 12, taxAmountUSD: 0, saleCount: 4, status: 'paid', paidAt: iso(15), createdAt: iso(15) }];
    const db: any = { repositories: {
      storeModel: { findById: jest.fn(() => Object.assign(Promise.resolve({ sellerId: over.owner ?? 'seller-1', isDelete: false }), { select: () => ({ lean: () => Promise.resolve({ _id: 'st1' }) }) })) },
      sellerPlatformSubscriptionModel: { findOne: () => ({ lean: () => Promise.resolve(sub) }) },
      platformPlanInvoiceModel: { find: () => chain(invoices) },
      platformPlanPaymentAttemptModel: { find: () => chain(attempts) },
      platformAddonPurchaseModel: { find: () => chain(addons) },
      transactionFeeBillModel: { find: () => chain(fees) },
      platformPlanModel: { find: () => ({ select: () => ({ lean: () => Promise.resolve([{ _id: 'grow', name: 'Grow' }, { _id: 'pro', name: 'Pro' }]) }) }) },
    } };
    return new BillingTimelineService(db);
  }

  it('merges trial, plan changes, payments, failed attempt, refund, add-on and fee bill — newest first', async () => {
    const res = await make().getForSeller('seller-1', 'st1', {});
    const kinds = res.data.events.map(e => e.kind);
    for (const k of ['trial_started', 'trial_ended', 'plan_change', 'payment', 'payment_failed', 'refund', 'addon', 'transaction_fee']) expect(kinds).toContain(k);
    const times = res.data.events.map(e => new Date(e.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('shows the failed attempt with its reason and card, and the invoice with credit/tax line items', async () => {
    const { events } = (await make().getForSeller('seller-1', 'st1', {})).data;
    const failed = events.find(e => e.kind === 'payment_failed')!;
    expect(failed.reason).toMatch(/insufficient funds/);
    expect(failed.card).toEqual({ brand: 'visa', last4: '0341' });
    const inv = events.find(e => e.invoiceNumber === 'INV-2' && e.kind === 'payment')!;
    expect(inv.lineItems?.map(l => l.kind)).toEqual(['plan', 'credit', 'tax']);
    expect(inv.lineItems!.reduce((s, l) => s + l.amountUSD, 0)).toBe(60);
  });

  it('summary: lifetime paid (plans+add-ons+fees), refunds, net, credit balance, card on file', async () => {
    const { summary } = (await make().getForSeller('seller-1', 'st1', {})).data;
    expect(summary.lifetimePaidUSD).toBe(29 + 60 + 10 + 12);
    expect(summary.refundedUSD).toBe(10);
    expect(summary.netLifetimeUSD).toBe(101);
    expect(summary.creditBalanceUSD).toBe(5);
    expect(summary.card).toEqual({ brand: 'visa', last4: '4242' });
    expect(summary.breakdown).toMatchObject({ plans: 89, addons: 10, transactionFees: 12, refunds: -10 });
    expect(summary.failedPaymentsLast30Days).toBe(1);
  });

  it('date range + kind filter narrow the events and drive the statement totals', async () => {
    const q = { from: iso(12).toISOString(), to: new Date().toISOString(), kinds: 'payment,refund' };
    const { events, statement } = (await make().getForSeller('seller-1', 'st1', q)).data;
    expect(events.every(e => e.kind === 'payment' || e.kind === 'refund')).toBe(true);
    expect(events).toHaveLength(2); // INV-2 payment + its refund (INV-1 is outside the range)
    expect(statement).toMatchObject({ chargedUSD: 60, refundedUSD: 10, netUSD: 50, paymentCount: 1 });
  });

  it('a seller never sees provider references; the admin does', async () => {
    const seller = (await make().getForSeller('seller-1', 'st1', {})).data.events;
    expect(seller.every(e => e.internal === undefined)).toBe(true);
    const admin = (await make().getForAdmin('64b7f0f0f0f0f0f0f0f0f0f0', {})).data.events;
    expect(admin.find(e => e.invoiceNumber === 'INV-1' && e.kind === 'payment')!.internal).toMatchObject({ providerChargeId: 'pi_1', stripeInvoiceId: 'in_x' });
  });

  it('another seller gets 403', async () => {
    await expect(make({ owner: 'someone-else' }).getForSeller('seller-1', 'st1', {})).rejects.toThrow(ForbiddenException);
    await expect(make({ owner: 'someone-else' }).exportForSeller('seller-1', 'st1', {})).rejects.toThrow(ForbiddenException);
  });

  it('old invoices without saved line items still get a plan + tax breakdown', async () => {
    const old = { _id: 'o1', invoiceNumber: 'INV-0', platformPlanId: 'grow', type: 'recurring', status: 'paid', amountUSD: 32, subtotalUSD: 29, taxAmountUSD: 3, taxLabel: 'VAT', paidAt: iso(50), createdAt: iso(50) };
    const { events } = (await make({ invoices: [old] }).getForSeller('seller-1', 'st1', {})).data;
    const pay = events.find(e => e.kind === 'payment')!;
    expect(pay.lineItems).toEqual([{ kind: 'plan', label: 'Grow plan', amountUSD: 29 }, { kind: 'tax', label: 'VAT', amountUSD: 3 }]);
  });

  it('credit ledger: credit added on a downgrade-with-credit and credit used on a later invoice', async () => {
    const sub = { _id: 'sub1', storeId: 'st1', status: 'active', platformPlanId: 'pro', amountUSD: 79, creditBalanceUSD: 0, planHistory: [
      { fromPlanId: 'pro', fromPlanName: 'Pro', toPlanId: 'grow', toPlanName: 'Grow', proratedAmountUSD: -20, changedAt: iso(30), amountUSD: 29, interval: 'monthly' },
    ] };
    const inv = { _id: 'c1', invoiceNumber: 'INV-9', platformPlanId: 'pro', type: 'proration', status: 'paid', amountUSD: 59, taxAmountUSD: 0, paidAt: iso(2), createdAt: iso(2),
      lineItems: [{ kind: 'plan', label: 'Pro plan (monthly)', amountUSD: 79 }, { kind: 'credit', label: 'Account credit applied', amountUSD: -20 }] };
    const { events } = (await make({ sub, invoices: [inv], attempts: [], addons: [], fees: [] }).getForSeller('seller-1', 'st1', { kinds: 'credit' })).data;
    expect(events.map(e => e.creditUSD)).toEqual([-20, 20]); // newest first: used, then added
  });

  it('CSV: header + one row per event, quotes escaped, formula-injection guarded, no provider ids for sellers', async () => {
    const res = await make({ attempts: [{ _id: 'a1', outcome: 'failed', amountUSD: 5, failureReason: '=HYPERLINK("x"),bad', createdAt: iso(1) }] }).exportForSeller('seller-1', 'st1', {});
    const { csv, filename } = res.data;
    expect(filename).toMatch(/^billing-st1-all_all\.csv$/);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Amount USD');
    expect(lines[0]).not.toContain('Provider charge');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('""x""'); // embedded quotes doubled
    expect(lines.length).toBeGreaterThan(5);
  });

  it('admin CSV adds the provider columns', async () => {
    const { csv } = (await make().exportForAdmin('64b7f0f0f0f0f0f0f0f0f0f0', {})).data;
    expect(csv.split('\n')[0]).toContain('Provider charge');
    expect(csv).toContain('pi_1');
  });
});
