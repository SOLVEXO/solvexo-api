import { TransactionFeeBillingService } from './transaction-fee-billing.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

/** A seller with no card on file still owes the transaction fee: the bill waits for a payment instead of piling up unseen. */

const NOW = new Date(Date.UTC(2026, 10, 1, 4, 0, 0)); // 1 Nov 2026 -> bills October
const OCT = new Date(Date.UTC(2026, 9, 15));

function setup(opts: { customer?: string | null; feeUSD?: number; tax?: number; stripeFails?: boolean } = {}) {
  const tx = new FakeModel();
  const feeUSD = opts.feeUSD ?? 12;
  tx.rows.push({ _id: 't1', storeId: 's1', type: 'fee', amount: -feeUSD, currency: 'USD', createdAt: OCT, metadata: { billing: { status: 'pending_invoice' } } });
  (tx as any).aggregate = async (pipe: any[]) => {
    const match = pipe[0].$match;
    const rows = tx.rows.filter((r) => r.storeId === match.storeId && r.type === 'fee' && r.metadata?.billing?.status === 'pending_invoice' && (!match.createdAt || r.createdAt < match.createdAt.$lt));
    if (!rows.length) return [];
    return [{ _id: 'USD', amount: rows.reduce((s, r) => s + Math.abs(r.amount), 0), count: rows.length }];
  };
  const bills = new FakeModel({ isDelete: false }); // the real schema defaults isDelete to false
  const stores = new FakeModel(); stores.rows.push({ _id: 's1', sellerId: 'sel1', name: 'Shop' });
  const sellers = new FakeModel(); sellers.rows.push({ _id: 'sel1', stripeCustomerId: opts.customer === undefined ? null : opts.customer });
  const stripeCalls: string[] = [];
  const stripe: any = {
    invoiceItems: { create: async () => { stripeCalls.push('item'); return {}; } },
    invoices: {
      create: async () => { stripeCalls.push('invoice'); if (opts.stripeFails) throw new Error('card declined'); return { id: 'in_1' }; },
      finalizeInvoice: async () => ({ id: 'in_1', status: 'open', hosted_invoice_url: 'https://stripe.test/in_1' }),
      pay: async () => ({ id: 'in_1', status: 'paid', hosted_invoice_url: 'https://stripe.test/in_1' }),
    },
  };
  const notes: any[] = [];
  const notifications: any = { notify: async (n: any) => { notes.push(n); } };
  const logs: any[] = [];
  const tax: any = opts.tax ? { quoteForStore: async (_s: string, net: number) => ({ netUSD: net, taxUSD: Math.round(net * opts.tax!) / 100, totalUSD: 0 }), taxRateIdForStore: async () => null } : undefined;
  const db: any = { repositories: { transactionModel: tx, transactionFeeBillModel: bills, storeModel: stores, sellerModel: sellers } };
  const svc = new TransactionFeeBillingService(db, { stripeClient: stripe } as any, { convert: async (a: number) => a } as any, { log: (l: any) => logs.push(l) } as any, tax, notifications);
  return { svc, tx, bills, sellers, notes, logs, stripeCalls };
}

describe('fees of a seller with no card on file', () => {
  it('become a bill that waits for payment, the fee rows are claimed, no Stripe call is made', async () => {
    const k = setup();
    const r = await k.svc.billAccruedFees(NOW);
    expect(r.awaitingPayment).toBe(1);
    expect(k.stripeCalls.length).toBe(0);
    const bill = k.bills.rows[0];
    expect(bill.status).toBe('awaiting_payment');
    expect(bill.collectionMode).toBe('manual');
    expect(bill.amountUSD).toBe(12);
    expect(bill.periodKey).toBe('2026-10');
    expect(bill.dueAt > NOW || bill.dueAt > new Date(NOW.getTime() - 1)).toBe(true);
    expect(k.tx.rows[0].metadata.billing.status).toBe('invoiced');
    expect(k.tx.rows[0].metadata.billing.billId).toBe(String(bill._id));
  });

  it('tells the seller what is due and how to pay', async () => {
    const k = setup({ feeUSD: 20 });
    await k.svc.billAccruedFees(NOW);
    expect(k.notes.length).toBe(1);
    expect(k.notes[0].type).toBe(NOTIFICATION_TYPES.TRANSACTION_FEE_DUE);
    expect(k.notes[0].recipientRole).toBe('seller');
    expect(k.notes[0].title).toContain('20.00');
    expect(k.notes[0].body).toContain('bank transfer');
  });

  it('Solvexo\'s tax is added to what the seller owes', async () => {
    const k = setup({ feeUSD: 100, tax: 18 });
    await k.svc.billAccruedFees(NOW);
    expect(k.bills.rows[0].taxAmountUSD).toBe(18);
    expect(k.notes[0].title).toContain('118.00');
  });

  it('running again the same month neither bills nor notifies twice', async () => {
    const k = setup();
    await k.svc.billAccruedFees(NOW);
    const second = await k.svc.billAccruedFees(NOW);
    expect(k.bills.rows.length).toBe(1);
    expect(k.notes.length).toBe(1);
    expect(second.awaitingPayment).toBe(0);
  });

  it('a total under the Stripe minimum still rolls into the next month', async () => {
    const k = setup({ feeUSD: 0.2 });
    const r = await k.svc.billAccruedFees(NOW);
    expect(r.carried).toBe(1);
    expect(k.bills.rows.length).toBe(0);
  });
});

describe('closing a bill that was paid by bank transfer', () => {
  it('marks it paid, records who and the note, and thanks the seller', async () => {
    const k = setup();
    await k.svc.billAccruedFees(NOW);
    const id = String(k.bills.rows[0]._id);
    const bill: any = await k.svc.markPaidManually(id, 'admin1', 'Transfer ref 4471');
    expect(bill.status).toBe('paid');
    expect(k.bills.rows[0].markedPaidBy).toBe('admin1');
    expect(k.bills.rows[0].paymentNote).toBe('Transfer ref 4471');
    expect(k.notes[k.notes.length - 1].type).toBe(NOTIFICATION_TYPES.TRANSACTION_FEE_PAID);
  });

  it('a bill that is already paid, or does not exist, can not be closed again', async () => {
    const k = setup();
    await k.svc.billAccruedFees(NOW);
    const id = String(k.bills.rows[0]._id);
    await k.svc.markPaidManually(id, 'admin1');
    expect(await k.svc.markPaidManually(id, 'admin2')).toBeNull();
    expect(await k.svc.markPaidManually('missing', 'admin1')).toBeNull();
    expect(k.bills.rows[0].markedPaidBy).toBe('admin1');
  });
});

describe('the seller adds a card later', () => {
  it('the waiting bill is charged to the card on the next run', async () => {
    const k = setup();
    await k.svc.billAccruedFees(NOW);
    k.sellers.rows[0].stripeCustomerId = 'cus_9';
    expect(await k.svc.collectAwaitingWithCards()).toBe(1);
    expect(k.bills.rows[0].status).toBe('paid');
    expect(k.bills.rows[0].collectionMode).toBe('stripe');
    expect(k.stripeCalls).toEqual(['item', 'invoice']);
  });

  it('while there is still no card nothing is charged', async () => {
    const k = setup();
    await k.svc.billAccruedFees(NOW);
    expect(await k.svc.collectAwaitingWithCards()).toBe(0);
    expect(k.bills.rows[0].status).toBe('awaiting_payment');
  });

  it('a card that fails leaves the bill waiting, with the reason, and the fee rows still claimed', async () => {
    const k = setup({ stripeFails: true });
    await k.svc.billAccruedFees(NOW);
    k.sellers.rows[0].stripeCustomerId = 'cus_9';
    expect(await k.svc.collectAwaitingWithCards()).toBe(0);
    expect(k.bills.rows[0].status).toBe('awaiting_payment');
    expect(String(k.bills.rows[0].failureReason)).toContain('declined');
    expect(k.tx.rows[0].metadata.billing.status).toBe('invoiced');
  });
});
