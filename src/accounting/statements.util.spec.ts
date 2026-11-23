/* eslint-disable prettier/prettier */
import { DEFAULT_ACCOUNTS } from './chart.const';
import { balanceSheet, channelOf, monthsBetween, profitAndLoss, salesTaxSummary } from './statements.util';
import { detectColumns, matchLine, parseAmount, parseCsv, toLines } from './settlement.util';
import { isSkip, orderCogsEntry, posSaleEntry } from './posting-rules.util';

const accounts = DEFAULT_ACCOUNTS.map(a => ({ key: a.key, code: a.code, name: a.name, type: a.type, group: a.group }));
const ctx = { base: 'PKR', exp: 2 };

describe('profit and loss', () => {
  const rows = [
    { accountKey: 'sales_pos', bucket: '2026-11', debitMinor: 0, creditMinor: 100000 },
    { accountKey: 'sales_online', bucket: '2026-12', debitMinor: 0, creditMinor: 50000 },
    { accountKey: 'sales_returns', bucket: '2026-11', debitMinor: 5000, creditMinor: 0 },
    { accountKey: 'cogs', bucket: '2026-11', debitMinor: 60000, creditMinor: 0 },
    { accountKey: 'exp_rent', bucket: '2026-12', debitMinor: 20000, creditMinor: 0 },
    { accountKey: 'other_income', bucket: '2026-12', debitMinor: 0, creditMinor: 1000 },
    { accountKey: 'cash', bucket: '2026-11', debitMinor: 100000, creditMinor: 0 }, // balance sheet: ignored
  ];
  it('splits sales, cost of sales, expenses and other income per month, with gross and net profit', () => {
    const p = profitAndLoss(accounts, rows, ['2026-11', '2026-12']);
    const sec = (id: string) => p.sections.find(s => s.id === id)!;
    expect(sec('income').values).toEqual({ '2026-11': 95000, '2026-12': 50000 }); // returns reduce sales
    expect(sec('cost_of_sales').total).toBe(60000);
    expect(sec('expenses').lines.map(l => l.key)).toEqual(['exp_rent']);
    expect(sec('other_income').total).toBe(1000);
    expect(p.grossProfit.values).toEqual({ '2026-11': 35000, '2026-12': 50000 });
    expect(p.netProfit).toEqual({ values: { '2026-11': 35000, '2026-12': 31000 }, total: 66000 });
  });
});

describe('balance sheet', () => {
  it('balances with the unclosed profit as an equity line', () => {
    const b = balanceSheet(accounts, [
      { accountKey: 'cash', debitMinor: 150000, creditMinor: 20000 },
      { accountKey: 'inventory', debitMinor: 80000, creditMinor: 60000 },
      { accountKey: 'payables', debitMinor: 0, creditMinor: 30000 },
      { accountKey: 'capital', debitMinor: 0, creditMinor: 100000 },
      { accountKey: 'sales_pos', debitMinor: 0, creditMinor: 100000 },
      { accountKey: 'cogs', debitMinor: 60000, creditMinor: 0 },
      { accountKey: 'exp_rent', debitMinor: 20000, creditMinor: 0 },
    ]);
    expect(b.totals.assetsMinor).toBe(150000);
    expect(b.currentProfitMinor).toBe(20000);
    expect(b.totals).toMatchObject({ liabilitiesMinor: 30000, equityMinor: 120000, balanced: true });
  });
});

describe('sales tax summary', () => {
  it('output minus input tax per month', () => {
    const r = salesTaxSummary([
      { accountKey: 'output_tax', bucket: '2026-11', debitMinor: 900, creditMinor: 18000 },
      { accountKey: 'input_tax', bucket: '2026-11', debitMinor: 5000, creditMinor: 0 },
    ], ['2026-11', '2026-12']);
    expect(r.months[0]).toEqual({ month: '2026-11', outputMinor: 17100, inputMinor: 5000, payableMinor: 12100 });
    expect(r.months[1].payableMinor).toBe(0);
    expect(r.totals.payableMinor).toBe(12100);
  });
});

describe('channels and months', () => {
  it('derives the channel of entries made before Phase 3', () => {
    expect(channelOf('pos_sale', null)).toBe('pos');
    expect(channelOf('order', null)).toBe('online');
    expect(channelOf('expense', null)).toBe('other');
    expect(channelOf('order', 'b2b')).toBe('b2b');
  });
  it('lists the months of a period', () => {
    expect(monthsBetween('2026-11-05', '2027-02-01')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
  it('POS entries carry their channel and branch', () => {
    const e = posSaleEntry({ _id: 's', status: 'completed', currency: 'PKR', totalMinor: 100, taxMinor: 0, payments: [{ method: 'cash', amountMinor: 100 }], locationId: 'loc1', createdAt: '2026-11-20' }, ctx);
    expect(isSkip(e) ? null : [e.channel, e.locationId]).toEqual(['pos', 'loc1']);
  });
});

describe('online cost of goods sold', () => {
  const order = { _id: 'o1', orderNumber: 'ORD-1', paymentType: 'jazzcash' };
  it('uses the batch cost when there is one, else the variant cost; skips cancelled and digital lines', () => {
    const so = { storeId: 'st', items: [
      { variantId: 'v1', quantity: 2, costOfGoodsSold: 300 },
      { variantId: 'v2', quantity: 3 },
      { variantId: 'v3', quantity: 1, status: 'cancelled' },
      { variantId: 'v4', quantity: 1, type: 'digital' },
      { variantId: 'v5', quantity: 1 },
    ] };
    const r: any = orderCogsEntry(order, so, ctx, id => ({ v2: 5000, v5: null } as any)[id] ?? null, new Date('2026-11-20'));
    expect(r.lines).toEqual([{ accountKey: 'cogs', debitMinor: 45000, creditMinor: 0, memo: '' }, { accountKey: 'inventory', debitMinor: 0, creditMinor: 45000, memo: '' }]);
    expect(r.missing).toBe(1);
    expect(r.channel).toBe('online');
  });
  it('bundles take their components’ costs; nothing known means skipped', () => {
    const so = { storeId: 'st', items: [{ quantity: 2, bundleComponents: [{ variantId: 'a', quantity: 1 }, { variantId: 'b', quantity: 2 }] }] };
    const r: any = orderCogsEntry(order, so, ctx, id => ({ a: 100, b: 50 } as any)[id], new Date());
    expect(r.lines[0].debitMinor).toBe(400);
    expect(orderCogsEntry(order, { storeId: 'st', items: [{ variantId: 'x', quantity: 1 }] }, ctx, () => null, new Date())).toEqual({ skip: 'no_cost' });
  });
});

describe('settlement files', () => {
  it('reads quoted CSV with commas, quotes and CRLF', () => {
    expect(parseCsv('a,b\r\n"1,5","say ""hi"""\r\n\r\n2,3')).toEqual([['a', 'b'], ['1,5', 'say "hi"'], ['2', '3']]);
  });
  it('finds the columns of common gateway reports', () => {
    expect(detectColumns(['Transaction Date', 'pp_TxnRefNo', 'Transaction Amount', 'Fee', 'Net Amount'])).toEqual({ date: 0, reference: 1, gross: 2, fee: 3, net: 4 });
    expect(detectColumns(['Order ID', 'Amount', 'Commission', 'Settled Amount'])).toMatchObject({ reference: 0, gross: 1, fee: 2, net: 3 });
  });
  it('parses amounts with currency text, commas and brackets', () => {
    expect(parseAmount('Rs. 1,250.50')).toBe(1250.5);
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('PKR -300')).toBe(-300);
    expect(parseAmount('n/a')).toBeNull();
  });
  it('derives the missing amount and reports unusable rows', () => {
    const { lines, problems } = toLines([['T1', '1000', '25'], ['', '5', '0'], ['T3', '', '']], { reference: 0, gross: 1, fee: 2 }, 2);
    expect(lines).toEqual([{ row: 2, date: null, reference: 'T1', grossMinor: 100000, feeMinor: 2500, netMinor: 97500 }]);
    expect(problems).toEqual([{ row: 3, reason: 'no reference' }, { row: 4, reason: 'no amount' }]);
  });
  it('matches within one unit of rounding; otherwise flags the difference', () => {
    expect(matchLine(100000, { orderIds: ['o'], orderNumbers: ['N'], expectedMinor: 100050 }, false, 2).status).toBe('matched');
    expect(matchLine(100000, { orderIds: ['o'], orderNumbers: ['N'], expectedMinor: 90000 }, false, 2).status).toBe('amount_differs');
    expect(matchLine(100000, null, false, 2).status).toBe('unmatched');
    expect(matchLine(100000, null, true, 2).status).toBe('duplicate');
  });
});
