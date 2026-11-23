/* eslint-disable prettier/prettier */
import {
  cashMovementEntry, expenseEntry, finalize, financeTxEntry, isSkip, khataEntry, orderRefundEntry, orderSaleEntry, payoutEntry, posRefundEntry,
  posSaleEntry, posVoidEntry, receiptEntry, shiftCloseEntry, stockMovementEntry, supplierEntry, type EntryDraft, type RuleResult,
} from './posting-rules.util';
import { openingLines, trialBalance } from './trial-balance.util';
import { DEFAULT_ACCOUNTS, EXPENSE_CATEGORY_ACCOUNT } from './chart.const';

const ctx = { base: 'PKR', exp: 2 };
const d = (r: RuleResult) => { if (isSkip(r)) throw new Error(`skipped: ${r.skip}`); return r; };
/** account → signed amount (debit +, credit −), for compact assertions. */
const net = (e: EntryDraft) => e.lines.reduce<Record<string, number>>((m, l) => { m[l.accountKey] = (m[l.accountKey] ?? 0) + l.debitMinor - l.creditMinor; return m; }, {});
const balanced = (e: EntryDraft) => expect(e.lines.reduce((t, l) => t + l.debitMinor - l.creditMinor, 0)).toBe(0);
const KEYS = new Set(DEFAULT_ACCOUNTS.map(a => a.key));
const knownAccounts = (e: EntryDraft) => e.lines.forEach(l => expect(KEYS.has(l.accountKey)).toBe(true));

describe('chart of accounts', () => {
  it('has unique keys and codes, and every expense category maps to an account', () => {
    expect(new Set(DEFAULT_ACCOUNTS.map(a => a.key)).size).toBe(DEFAULT_ACCOUNTS.length);
    expect(new Set(DEFAULT_ACCOUNTS.map(a => a.code)).size).toBe(DEFAULT_ACCOUNTS.length);
    for (const k of Object.values(EXPENSE_CATEGORY_ACCOUNT)) expect(KEYS.has(k)).toBe(true);
  });
});

describe('finalize', () => {
  it('throws on an unbalanced draft and drops zero lines', () => {
    const base = { sourceType: 't', sourceId: '1', sourceKey: 't:1', date: new Date(), reference: '', memo: '' };
    expect(() => finalize({ ...base, lines: [{ accountKey: 'cash', debitMinor: 10, creditMinor: 0 }, { accountKey: 'bank', debitMinor: 0, creditMinor: 9 }] })).toThrow(/Unbalanced/);
    const ok = finalize({ ...base, lines: [{ accountKey: 'cash', debitMinor: 10, creditMinor: 0 }, { accountKey: 'bank', debitMinor: 0, creditMinor: 10 }, { accountKey: 'grni', debitMinor: 0, creditMinor: 0 }] });
    expect(ok.lines).toHaveLength(2);
  });
});

describe('POS', () => {
  const sale = {
    _id: 's1', status: 'completed', currency: 'PKR', currencyExponent: 2, totalMinor: 11800, taxMinor: 1800, saleNumber: 'POS-1',
    invoice: { number: 'INV-000001', issuedAt: '2026-11-20T10:00:00Z' },
    payments: [{ method: 'cash', amountMinor: 5000 }, { method: 'card', amountMinor: 6800 }],
  };

  it('a split-tender sale debits each tender and credits sales net of tax and output tax', () => {
    const e = d(posSaleEntry(sale, ctx));
    balanced(e); knownAccounts(e);
    expect(net(e)).toEqual({ cash: 5000, card_clearing: 6800, sales_pos: -10000, output_tax: -1800 });
    expect(e.sourceKey).toBe('pos_sale:s1');
    expect(e.reference).toBe('INV-000001');
    expect(e.date.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it('a loyalty / rounding gap goes to sales returns and discounts; a legacy sale without payments uses paymentMethod', () => {
    expect(net(d(posSaleEntry({ ...sale, payments: [{ method: 'cash', amountMinor: 11500 }] }, ctx)))).toEqual({ cash: 11500, sales_returns: 300, sales_pos: -10000, output_tax: -1800 });
    expect(net(d(posSaleEntry({ ...sale, payments: [], paymentMethod: 'other' }, ctx)))).toEqual({ other_clearing: 11800, sales_pos: -10000, output_tax: -1800 });
  });

  it('skips held / discarded sales and sales in another currency', () => {
    expect(posSaleEntry({ ...sale, status: 'held' }, ctx)).toEqual({ skip: 'not_final' });
    expect(posSaleEntry({ ...sale, currency: 'USD' }, ctx)).toEqual({ skip: 'currency' });
  });

  it('falls back to major amounts on legacy sales', () => {
    const e = d(posSaleEntry({ _id: 's2', status: 'completed', total: 100, tax: 0, paymentMethod: 'cash', payments: [], createdAt: '2026-11-01' }, ctx));
    expect(net(e)).toEqual({ cash: 10000, sales_pos: -10000 });
  });

  it('a refund returns money by tender and reverses tax from its credit note', () => {
    const e = d(posRefundEntry({ _id: 'r1', amountMinor: 5900, currency: 'PKR', tenders: [{ method: 'cash', amountMinor: 5900 }], reference: 'POS-1-R1', createdAt: '2026-11-21' }, { taxMinor: 900 }, ctx));
    balanced(e);
    expect(net(e)).toEqual({ output_tax: 900, sales_returns: 5000, cash: -5900 });
  });

  it('a void takes the whole sale back through its credit note', () => {
    const e = d(posVoidEntry({ _id: 'cn1', kind: 'void', number: 'CN-1', currency: 'PKR', totalMinor: 11800, taxMinor: 1800, tenders: [{ method: 'cash', amountMinor: 5000 }, { method: 'card', amountMinor: 6800 }], createdAt: '2026-11-20' }, ctx));
    expect(net(e)).toEqual({ output_tax: 1800, sales_returns: 10000, cash: -5000, card_clearing: -6800 });
    expect(posVoidEntry({ _id: 'cn2', kind: 'return' }, ctx)).toEqual({ skip: 'not_void' });
  });

  it('expenses debit their category account and credit how they were paid', () => {
    const e = d(expenseEntry({ _id: 'x1', category: 'rent', amountMinor: 3000000, method: 'bank', currency: 'PKR', occurredAt: '2026-11-05', number: 'EXP-1' }, ctx));
    expect(net(e)).toEqual({ exp_rent: 3000000, bank: -3000000 });
    expect(d(expenseEntry({ _id: 'x1', category: 'other', amountMinor: 100, method: 'cash', currency: 'PKR' }, ctx, ':1')).sourceKey).toBe('expense:x1:1');
  });

  it('cash movements: bank deposit, owner drawing, float top-up; expense cash-outs are skipped', () => {
    const session = { _id: 'ss1', currency: 'PKR', currencyExponent: 2 };
    expect(net(d(cashMovementEntry(session, { type: 'cash_out', category: 'bank_deposit', amountMinor: 50000 }, 0, ctx)))).toEqual({ bank: 50000, cash: -50000 });
    expect(net(d(cashMovementEntry(session, { type: 'cash_out', category: 'owner_draw', amountMinor: 1000 }, 1, ctx)))).toEqual({ drawings: 1000, cash: -1000 });
    expect(net(d(cashMovementEntry(session, { type: 'cash_in', category: 'float_topup', amountMinor: 2000 }, 2, ctx)))).toEqual({ cash: 2000, cash_safe: -2000 });
    expect(cashMovementEntry(session, { type: 'cash_out', category: 'expense', amountMinor: 2000 }, 3, ctx)).toEqual({ skip: 'posted_with_expense' });
    expect(d(cashMovementEntry(session, { type: 'cash_in', category: 'other_in', amountMinor: 1, requestId: 'req-9' }, 4, ctx)).sourceKey).toBe('cash:ss1:req-9');
  });

  it('a shift that closes short or over moves the difference to cash over and short', () => {
    expect(net(d(shiftCloseEntry({ _id: 'ss1', status: 'closed', currency: 'PKR', cashDifferenceMinor: -500, closedAt: '2026-11-20' }, ctx)))).toEqual({ cash_over_short: 500, cash: -500 });
    expect(net(d(shiftCloseEntry({ _id: 'ss2', status: 'closed', currency: 'PKR', cashDifferenceMinor: 300 }, ctx)))).toEqual({ cash: 300, cash_over_short: -300 });
    expect(shiftCloseEntry({ _id: 'ss3', status: 'closed', cashDifferenceMinor: 0 }, ctx)).toEqual({ skip: 'zero' });
    expect(shiftCloseEntry({ _id: 'ss4', status: 'open', cashDifferenceMinor: 10 }, ctx)).toEqual({ skip: 'open' });
  });
});

describe('stock', () => {
  it('sales move cost of goods sold; returns put it back; write-offs go to inventory adjustments', () => {
    expect(net(d(stockMovementEntry({ _id: 'm1', type: 'sale', qtyDelta: -2, unitCostMinor: 4000, createdAt: '2026-11-20' })))).toEqual({ cogs: 8000, inventory: -8000 });
    expect(net(d(stockMovementEntry({ _id: 'm2', type: 'return', qtyDelta: 1, unitCostMinor: 4000 })))).toEqual({ inventory: 4000, cogs: -4000 });
    expect(net(d(stockMovementEntry({ _id: 'm3', type: 'write_off', qtyDelta: -1, unitCostMinor: 4000 })))).toEqual({ inventory_adjustments: 4000, inventory: -4000 });
    expect(net(d(stockMovementEntry({ _id: 'm4', type: 'count', qtyDelta: 3, unitCostMinor: 100 })))).toEqual({ inventory: 300, inventory_adjustments: -300 });
  });

  it('skips receipts, transfers, purchase adjustments and movements without a cost', () => {
    expect(stockMovementEntry({ _id: 'm5', type: 'receive', qtyDelta: 5, unitCostMinor: 1 })).toEqual({ skip: 'not_posted_type' });
    expect(stockMovementEntry({ _id: 'm6', type: 'transfer_out', qtyDelta: -5, unitCostMinor: 1 })).toEqual({ skip: 'not_posted_type' });
    expect(stockMovementEntry({ _id: 'm7', type: 'adjustment', reason: 'purchase_received', qtyDelta: 5, unitCostMinor: 1 })).toEqual({ skip: 'posted_with_purchasing' });
    expect(stockMovementEntry({ _id: 'm8', type: 'sale', qtyDelta: -1, unitCostMinor: null })).toEqual({ skip: 'no_cost' });
  });
});

describe('purchasing', () => {
  it('goods received → inventory against goods received not invoiced; the bill clears it into payables', () => {
    expect(net(d(receiptEntry({ _id: 'rc1', currency: 'PKR', totalMinor: 90000, receiptNumber: 'GRN-1' }, ctx)))).toEqual({ inventory: 90000, grni: -90000 });
    expect(net(d(supplierEntry({ _id: 'b1', type: 'bill', refType: 'receipt', amountMinor: 90000, currency: 'PKR' }, ctx)))).toEqual({ grni: 90000, payables: -90000 });
  });

  it('payments, credits and adjustments', () => {
    expect(net(d(supplierEntry({ _id: 'p1', type: 'payment', amountMinor: -40000, method: 'bank', currency: 'PKR' }, ctx)))).toEqual({ payables: 40000, bank: -40000 });
    expect(net(d(supplierEntry({ _id: 'c1', type: 'credit', amountMinor: -5000, currency: 'PKR' }, ctx)))).toEqual({ payables: 5000, inventory: -5000 });
    expect(net(d(supplierEntry({ _id: 'a1', type: 'adjustment', amountMinor: 200, currency: 'PKR' }, ctx)))).toEqual({ inventory_adjustments: 200, payables: -200 });
    expect(supplierEntry({ _id: 'u1', type: 'bill', amountMinor: 1, currency: 'USD' }, ctx)).toEqual({ skip: 'currency' });
  });
});

describe('khata', () => {
  it('a POS sale on khata moves the amount from other payments to the customer; payments clear it', () => {
    expect(net(d(khataEntry({ _id: 'k1', type: 'sale', amount: 1180, source: 'pos' }, 'PKR', ctx)))).toEqual({ receivables: 118000, other_clearing: -118000 });
    expect(net(d(khataEntry({ _id: 'k2', type: 'payment', amount: -500, method: 'cash' }, 'PKR', ctx)))).toEqual({ cash: 50000, receivables: -50000 });
    expect(net(d(khataEntry({ _id: 'k3', type: 'payment', amount: -500, method: 'bank_transfer' }, 'PKR', ctx)))).toEqual({ bank: 50000, receivables: -50000 });
  });

  it('a manual credit sale is a khata sale; B2B sales post with their order; reversals mirror the original', () => {
    expect(net(d(khataEntry({ _id: 'k4', type: 'sale', amount: 100, source: 'manual' }, 'PKR', ctx)))).toEqual({ receivables: 10000, sales_khata: -10000 });
    expect(khataEntry({ _id: 'k5', type: 'sale', amount: 100, source: 'b2b' }, 'PKR', ctx)).toEqual({ skip: 'posted_with_order' });
    const original = { _id: 'k2', type: 'payment', amount: -500, method: 'cash' };
    expect(net(d(khataEntry({ _id: 'k6', type: 'reversal', amount: 500, reversesEntryId: 'k2' }, 'PKR', ctx, original)))).toEqual({ cash: -50000, receivables: 50000 });
  });
});

describe('online orders', () => {
  const order = (over: any = {}) => ({
    _id: 'o1', orderNumber: 'ORD-1', currency: 'PKR', paymentType: 'jazzcash', isPaid: true, paymentStatus: 'paid', paidAt: '2026-11-20', createdAt: '2026-11-19', ...over,
  });
  const so = (over: any = {}) => ({ storeId: 'st1', subtotal: 1000, taxAmount: 180, includedTaxAmount: 0, platformSponsoredDiscountUSD: 0, settlementCurrency: 'PKR', settlementAmount: 1180, items: [], status: 'processing', ...over });

  it('a paid order debits the gateway and credits sales and output tax', () => {
    const e = d(orderSaleEntry(order(), so(), ctx));
    balanced(e); knownAccounts(e);
    expect(net(e)).toEqual({ gateway_clearing: 118000, sales_online: -100000, output_tax: -18000 });
    expect(e.sourceKey).toBe('order:o1:st1');
  });

  it('cash on delivery counts once delivered; unpaid orders wait; a platform-held card sale sits on the Solvexo balance', () => {
    expect(orderSaleEntry(order({ paymentType: 'cash_on_delivery', isPaid: false, paymentStatus: 'unpaid' }), so(), ctx)).toEqual({ skip: 'not_recognised' });
    expect(net(d(orderSaleEntry(order({ paymentType: 'cash_on_delivery', isPaid: false, paymentStatus: 'unpaid' }), so({ status: 'delivered', deliveredAt: '2026-11-22' }), ctx)))).toEqual({ cod_receivable: 118000, sales_online: -100000, output_tax: -18000 });
    expect(net(d(orderSaleEntry(order({ paymentType: 'stripe' }), so(), ctx)))).toEqual({ solvexo_receivable: 118000, sales_online: -100000, output_tax: -18000 });
  });

  it('gift card and store credit shares of a direct sale are payments from those liabilities', () => {
    const e = d(orderSaleEntry(order({ paymentType: 'cash_on_delivery', isPaid: true }), so({ items: [{ giftCardDiscountUSD: 100, storeCreditDiscountUSD: 50 }] }), ctx));
    expect(net(e)).toEqual({ cod_receivable: 118000, gift_cards: 10000, customer_advances: 5000, sales_online: -115000, output_tax: -18000 });
  });

  it('an order settled in another currency is left out', () => {
    expect(orderSaleEntry(order({ currency: 'USD' }), so({ settlementCurrency: 'USD', settlementAmount: 10 }), ctx)).toEqual({ skip: 'currency' });
  });

  it('refunds post only the part not yet posted, with tax in proportion', () => {
    const o = order();
    const e = d(orderRefundEntry(o, so({ refundedTotal: 590 }), ctx, 0, new Date('2026-11-25')));
    expect(net(e)).toEqual({ output_tax: 9000, sales_returns: 50000, gateway_clearing: -59000 });
    expect(e.sourceKey).toBe('order_refund:o1:st1:59000');
    expect(orderRefundEntry(o, so({ refundedTotal: 590 }), ctx, 59000, new Date())).toEqual({ skip: 'zero' });
    expect(net(d(orderRefundEntry(o, so({ refundedTotal: 1180 }), ctx, 59000, new Date())))).toEqual({ output_tax: 9000, sales_returns: 50000, gateway_clearing: -59000 });
  });
});

describe('Solvexo balance', () => {
  it('fees debit platform fees; payouts move the balance to the bank', () => {
    expect(net(d(financeTxEntry({ _id: 't1', type: 'fee', amount: -25, currency: 'PKR', status: 'completed' }, ctx)))).toEqual({ platform_fees: 2500, solvexo_receivable: -2500 });
    expect(financeTxEntry({ _id: 't2', type: 'sale', amount: 100, currency: 'PKR' }, ctx)).toEqual({ skip: 'posted_with_order' });
    expect(net(d(payoutEntry({ _id: 'p1', status: 'completed', amount: 1000, currency: 'PKR' }, ctx)))).toEqual({ bank: 100000, solvexo_receivable: -100000 });
    expect(payoutEntry({ _id: 'p2', status: 'pending', amount: 1000, currency: 'PKR' }, ctx)).toEqual({ skip: 'not_final' });
  });
});

describe('trial balance and opening balances', () => {
  const accounts = DEFAULT_ACCOUNTS.map(a => ({ key: a.key, code: a.code, name: a.name, type: a.type, group: a.group }));

  it('shows each account on its normal side and checks debits equal credits', () => {
    const tb = trialBalance(accounts, [
      { accountKey: 'cash', debitMinor: 15000, creditMinor: 5000 },
      { accountKey: 'sales_pos', debitMinor: 0, creditMinor: 10000 },
    ]);
    expect(tb.rows.find(r => r.key === 'cash')!.balanceMinor).toBe(10000);
    expect(tb.rows.find(r => r.key === 'sales_pos')!.balanceMinor).toBe(10000);
    expect(tb.totals).toEqual({ debitMinor: 15000, creditMinor: 15000, balanced: true });
    expect(tb.rows.map(r => r.code)).toEqual(['1000', '4010']);
  });

  it('opening balances that do not net to zero are balanced through the suspense account', () => {
    const { lines, suspenseMinor } = openingLines([{ accountKey: 'cash', debitMinor: 5000, creditMinor: 0 }, { accountKey: 'inventory', debitMinor: 20000, creditMinor: 0 }, { accountKey: 'payables', debitMinor: 0, creditMinor: 8000 }]);
    expect(suspenseMinor).toBe(17000);
    expect(lines.at(-1)).toMatchObject({ accountKey: 'opening_suspense', creditMinor: 17000 });
    expect(lines.reduce((t, l) => t + l.debitMinor - l.creditMinor, 0)).toBe(0);
  });
});
