/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { startMongoHarness, MongoHarness } from '../pos/testing/mongo-harness';
import { KhataAccount, KhataAccountSchema, KhataEntry, KhataEntrySchema } from '../khata/khata.schema';
import { AccountingSettings, AccountingSettingsSchema, JournalEntry, JournalEntrySchema, LedgerAccount, LedgerAccountSchema } from './accounting.schema';
import { AccountingService } from './accounting.service';
import { AccountingSyncService } from './accounting-sync.service';
import { AccountingBooksService } from './accounting-books.service';
import { AccountingSettlementsService } from './accounting-settlements.service';
import { AccountingConnection, AccountingConnectionSchema, AccountingExportLog, AccountingExportLogSchema, GatewaySettlement, GatewaySettlementSchema } from './accounting.schema';
import { AccountingIntegrationsService } from './accounting-integrations.service';
import { DEFAULT_ACCOUNTS } from './chart.const';

jest.setTimeout(120_000);

let h: MongoHarness;
let svc: AccountingService;
let sync: AccountingSyncService;
let journal: any;
let books: AccountingBooksService;
let settlements: AccountingSettlementsService;
let integrations: AccountingIntegrationsService;
let accountsModel: any;
const STORE = 'store-acc-1';
const actor = { id: 'owner', role: 'seller' };
const GO_LIVE = '2026-11-01';
const raw = (model: any) => h.conn.collection(model.collection.name);

beforeAll(async () => {
  h = await startMongoHarness();
  const m = (cls: any, sch: any) => h.conn.model(cls.name, sch);
  const accounts = m(LedgerAccount, LedgerAccountSchema), settings = m(AccountingSettings, AccountingSettingsSchema);
  journal = m(JournalEntry, JournalEntrySchema);
  for (const x of [accounts, settings, journal]) await x.init();
  const repos = {
    ...h.repos,
    transactionModel: m(schema.Transaction, schema.TransactionSchema),
    payoutModel: m(schema.Payout, schema.PayoutSchema),
    posExpenseModel: m(schema.PosExpense, schema.PosExpenseSchema),
    posExpenseEventModel: m(schema.PosExpenseEvent, schema.PosExpenseEventSchema),
    purchaseReceiptModel: m(schema.PurchaseReceipt, schema.PurchaseReceiptSchema),
    supplierLedgerEntryModel: m(schema.SupplierLedgerEntry, schema.SupplierLedgerEntrySchema),
    paymentTransactionModel: m(schema.PaymentTransaction, schema.PaymentTransactionSchema),
  };
  h.repos.posExpenseModel = repos.posExpenseModel;
  h.repos.posExpenseEventModel = repos.posExpenseEventModel;
  const redis: any = { withLock: async (_k: string, _t: number, fn: () => Promise<void>) => { await fn(); return 'ran'; } };
  svc = new AccountingService(accounts as any, settings as any, journal);
  sync = new AccountingSyncService({ repositories: repos } as any, redis, svc, settings as any, journal, m(KhataEntry, KhataEntrySchema) as any, m(KhataAccount, KhataAccountSchema) as any);
  await svc.setup(STORE, { baseCurrency: 'PKR' }, { goLiveDate: GO_LIVE }, actor);
  const cashStub: any = { expenseGet: async (_r: any, _s: string, id: string) => ({ success: true, data: { expense: { id } } }) };
  process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'integration-test-key';
  accountsModel = accounts;
  const conns = m(AccountingConnection, AccountingConnectionSchema), xlog = m(AccountingExportLog, AccountingExportLogSchema);
  await conns.init(); await xlog.init();
  integrations = new AccountingIntegrationsService({ repositories: repos } as any, redis, svc, conns as any, xlog as any, journal, accounts as any);
  integrations.checkHost = async () => undefined;
  settlements = new AccountingSettlementsService({ repositories: repos } as any, svc, m(GatewaySettlement, GatewaySettlementSchema) as any);
  h.repos.paymentTransactionModel = repos.paymentTransactionModel;
  books = new AccountingBooksService({ repositories: repos } as any, cashStub, {} as any, {} as any, settings as any, accounts as any);
});
afterAll(async () => { await h?.stop(); });

const sale = (over: any = {}) => ({
  _id: new Types.ObjectId(), storeId: STORE, status: 'completed', currency: 'PKR', currencyExponent: 2, saleNumber: 'POS-00001',
  totalMinor: 11800, taxMinor: 1800, total: 118, tax: 18, payments: [{ method: 'cash', amountMinor: 11800, amount: 118 }],
  invoice: { number: 'INV-000001', issuedAt: new Date('2026-11-10T09:00:00Z') }, createdAt: new Date('2026-11-10T09:00:00Z'), updatedAt: new Date('2026-11-10T09:00:00Z'), ...over,
});

describe('Accounting: setup, sync and books (real MongoDB)', () => {
  it('seeds the default chart once', async () => {
    const rows = await svc.listAccounts(STORE);
    expect(rows).toHaveLength(DEFAULT_ACCOUNTS.length);
    await svc.setup(STORE, { baseCurrency: 'PKR' }, { goLiveDate: GO_LIVE }, actor);
    expect(await svc.listAccounts(STORE)).toHaveLength(DEFAULT_ACCOUNTS.length);
  });

  it('posts sales, cost of goods and expenses once; leaves out what happened before go-live', async () => {
    await raw(h.repos.saleModel).insertMany([
      sale(),
      sale({ saleNumber: 'POS-00000', invoice: { number: 'INV-000000', issuedAt: new Date('2026-10-20') }, createdAt: new Date('2026-10-20'), updatedAt: new Date('2026-11-02') }),
      sale({ status: 'held', saleNumber: 'POS-00002', invoice: null }),
    ]);
    await raw(h.repos.stockMovementModel).insertOne({ _id: new Types.ObjectId(), storeId: STORE, variantId: 'v1', type: 'sale', qtyDelta: -2, unitCostMinor: 3000, productName: 'Mug', createdAt: new Date('2026-11-10T09:00:00Z') });
    const expenseId = new Types.ObjectId();
    // As the POS records it: the store's expense counter moves with every expense number handed out.
    await raw(h.repos.posSettingsModel).insertOne({ storeId: STORE, expenseCounter: 1 });
    await raw(h.repos.posExpenseModel).insertOne({ _id: expenseId, storeId: STORE, number: 'EXP-000001', seq: 1, category: 'utilities', amountMinor: 250000, currency: 'PKR', currencyExponent: 2, method: 'cash', occurredAt: new Date('2026-11-11'), createdAt: new Date('2026-11-11') });

    const first = await sync.syncStore(STORE);
    expect(first).not.toBe('busy');
    expect((first as any).posted).toMatchObject({ pos_sale: 1, stock: 1, expense: 1 });
    expect((first as any).skipped.before_go_live).toBe(1);

    const tb = await svc.trialBalance(STORE, { asOf: '2026-11-30' });
    expect(tb.totals.balanced).toBe(true);
    const bal = (k: string) => tb.rows.find((r: any) => r.key === k)?.balanceMinor ?? 0;
    expect(bal('cash')).toBe(11800 - 250000);
    expect(bal('sales_pos')).toBe(10000);
    expect(bal('output_tax')).toBe(1800);
    expect(bal('cogs')).toBe(6000);
    expect(bal('exp_utilities')).toBe(250000);

    const again = await sync.syncStore(STORE);
    expect((again as any).posted).toEqual({});
    expect(await journal.countDocuments({ storeId: STORE })).toBe(3);

    // The expense is rejected: its entry is reversed, once.
    await raw(h.repos.posExpenseEventModel).insertOne({ _id: new Types.ObjectId(), storeId: STORE, expenseId: String(expenseId), type: 'rejected', createdAt: new Date('2026-11-12') });
    await sync.syncStore(STORE);
    await sync.syncStore(STORE);
    expect(await journal.countDocuments({ storeId: STORE, kind: 'reversal' })).toBe(1);
    expect((await svc.trialBalance(STORE, {})).rows.find((r: any) => r.key === 'exp_utilities')?.balanceMinor).toBe(0);
  });

  it('balances opening amounts through suspense and replaces them by reversal', async () => {
    const lines = [{ accountKey: 'cash', debitMinor: 50000 }, { accountKey: 'inventory', debitMinor: 200000 }, { accountKey: 'payables', creditMinor: 80000 }];
    const r1 = await svc.setOpeningBalances(STORE, { lines }, actor);
    expect(r1.suspenseMinor).toBe(170000);
    const r2 = await svc.setOpeningBalances(STORE, { lines: [{ accountKey: 'cash', debitMinor: 10000 }, { accountKey: 'capital', creditMinor: 10000 }] }, actor);
    expect(r2.suspenseMinor).toBe(0);
    expect(await journal.exists({ storeId: STORE, reversesEntryId: String(r1.entry!._id) })).toBeTruthy();
    expect((await svc.trialBalance(STORE, {})).totals.balanced).toBe(true);
  });

  it('manual entries must balance; an entry reverses once and a reversal cannot be reversed', async () => {
    await expect(svc.manualEntry(STORE, { date: '2026-11-15', lines: [{ accountKey: 'bank', debitMinor: 100 }, { accountKey: 'capital', creditMinor: 90 }] }, actor)).rejects.toThrow(/must be equal/);
    await expect(svc.manualEntry(STORE, { date: '2026-10-15', lines: [{ accountKey: 'bank', debitMinor: 100 }, { accountKey: 'capital', creditMinor: 100 }] }, actor)).rejects.toThrow(/go-live/);
    const e = await svc.manualEntry(STORE, { date: '2026-11-15', memo: 'Owner put money in', lines: [{ accountKey: 'bank', debitMinor: 100000 }, { accountKey: 'capital', creditMinor: 100000 }] }, actor);
    const rev = await svc.reverse(STORE, String(e!._id), actor, 'typo');
    await expect(svc.reverse(STORE, String(e!._id), actor)).rejects.toThrow(/already been reversed/);
    await expect(svc.reverse(STORE, String(rev._id), actor)).rejects.toThrow(/cannot itself be reversed/);
    const check = await svc.check(STORE);
    expect(check.ok).toBe(true);
  });

  it('journal entries cannot be edited or deleted', async () => {
    await expect(journal.updateOne({ storeId: STORE }, { $set: { memo: 'x' } })).rejects.toThrow(/append-only/);
    await expect(journal.deleteOne({ storeId: STORE })).rejects.toThrow(/append-only/);
  });

  it('a web expense gets the next EXP number, is approved at once and posts to the account chosen for its category', async () => {
    const store = { _id: STORE, sellerId: 'seller-1', baseCurrency: 'PKR' };
    await expect(books.createExpense(store, { category: 'rent', method: 'bank', amountMinor: 0 }, actor)).rejects.toThrow(/above 0/);
    await expect(books.setExpenseAccounts(STORE, { accounts: { rent: 'cash' } })).rejects.toThrow(/expense account/);
    await books.setExpenseAccounts(STORE, { accounts: { rent: 'exp_other' } });
    const r: any = await books.createExpense(store, { category: 'rent', method: 'bank', amountMinor: 4_000_000, occurredAt: '2026-11-16', requestId: 'web-req-1' }, actor);
    const again: any = await books.createExpense(store, { category: 'rent', method: 'bank', amountMinor: 4_000_000, requestId: 'web-req-1' }, actor);
    expect(again.data.expense.id).toBe(r.data.expense.id); // idempotent per requestId
    const doc: any = await h.repos.posExpenseModel.findById(r.data.expense.id).lean();
    expect(doc.number).toBe('EXP-000002'); // the next number after the POS expense above
    expect(doc.sessionId).toBeNull();
    expect(await h.repos.posExpenseEventModel.countDocuments({ expenseId: r.data.expense.id, type: 'approved' })).toBe(1);
    await sync.syncStore(STORE);
    const e = await journal.findOne({ storeId: STORE, sourceType: 'expense', sourceId: r.data.expense.id }).lean();
    expect(e.lines.map((l: any) => [l.accountKey, l.debitMinor, l.creditMinor])).toEqual([['exp_other', 4_000_000, 0], ['bank', 0, 4_000_000]]);
  });

  it('an online JazzCash order posts its sale and cost; the gateway settlement matches it and empties the clearing account', async () => {
    const variantId = new Types.ObjectId();
    await raw(h.repos.productVariantModel).insertOne({ _id: variantId, costPriceMinor: 40000 });
    const orderId = new Types.ObjectId();
    await raw(h.repos.orderModel).insertOne({
      _id: orderId, orderNumber: 'ORD-77', currency: 'PKR', paymentType: 'jazzcash', isPaid: true, paymentStatus: 'paid', paidAt: new Date('2026-11-18'),
      createdAt: new Date('2026-11-18'), updatedAt: new Date('2026-11-18'),
      sellerOrders: [{ storeId: STORE, sellerId: 'seller-1', subtotal: 1000, taxAmount: 180, includedTaxAmount: 0, platformSponsoredDiscountUSD: 0, settlementCurrency: 'PKR', settlementAmount: 1180, status: 'processing',
        items: [{ productId: 'p1', variantId: String(variantId), type: 'physical', quantity: 2, price: 500, totalPrice: 1000 }] }],
    });
    await raw(h.repos.paymentTransactionModel).insertOne({ _id: new Types.ObjectId(), providerSessionId: 'T20261118000001', orderIds: [String(orderId)], checkoutId: 'c1', amount: 1180, currency: 'PKR' });
    await sync.syncStore(STORE);
    const sale = await journal.findOne({ storeId: STORE, sourceKey: `order:${orderId}:${STORE}` }).lean();
    expect(sale.channel).toBe('online');
    const cogs = await journal.findOne({ storeId: STORE, sourceKey: `order_cogs:${orderId}:${STORE}` }).lean();
    expect(cogs.totalMinor).toBe(80000);

    const csv = 'Transaction Date,pp_TxnRefNo,Transaction Amount,Fee,Net Amount\n2026-11-18,T20261118000001,"1,180.00",29.50,1150.50\n2026-11-18,T99,100.00,2.00,98.00\n';
    const imp: any = await settlements.import(STORE, { gateway: 'jazzcash', settledOn: '2026-11-20', csv, fileName: 'jazz-nov.csv' }, actor);
    expect(imp.settlement.lines.map((l: any) => l.match.status)).toEqual(['matched', 'unmatched']);
    expect(imp.settlement.totals).toMatchObject({ grossMinor: 128000, feeMinor: 3150, netMinor: 124850, matched: 1, unmatched: 1 });
    const posted: any = await settlements.post(STORE, String(imp.settlement._id), actor);
    expect(posted.status).toBe('posted');
    await expect(settlements.post(STORE, String(imp.settlement._id), actor)).rejects.toThrow(/already posted/);
    const again: any = await settlements.import(STORE, { gateway: 'jazzcash', settledOn: '2026-11-21', csv }, actor);
    expect(again.settlement.lines.every((l: any) => l.match.status === 'duplicate')).toBe(true);

    const tb = await svc.trialBalance(STORE, {});
    const bal = (k: string) => tb.rows.find((r: any) => r.key === k)?.balanceMinor ?? 0;
    expect(bal('gateway_clearing')).toBe(118000 - 128000); // the unmatched T99 line is the visible difference
    expect(bal('processing_fees')).toBe(3150);
    expect(tb.totals.balanced).toBe(true);
  });

  it('Odoo sync sends every entry once, records failures and retries them; Tally export carries every account used', async () => {
    let failCreate = true; let created = 0;
    const seenRefs = new Set<string>();
    integrations.fetchFn = (async (_u: string, init: any) => {
      const p = JSON.parse(init.body).params;
      const ok = (result: any) => ({ ok: true, status: 200, json: async () => ({ result }), text: async () => JSON.stringify({ result }) });
      if (p.service === 'common') return ok(5);
      const [, , , model, method, args] = p.args;
      if (model === 'account.journal') return ok([{ id: 1, name: 'Misc' }]);
      if (model === 'account.account') return ok(args[0][0][2].map((code: string, i: number) => ({ id: i + 10, code })));
      if (model === 'account.move' && method === 'search_read') return ok(seenRefs.has(args[0][0][2]) ? [{ id: 1 }] : []);
      if (model === 'account.move' && method === 'create') {
        if (failCreate && created === 0) { created++; return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }; }
        created++; seenRefs.add(args[0].ref); return ok(created);
      }
      return ok(true);
    }) as any;
    // Give every account its Odoo code (the seller would do this in the chart of accounts).
    const all = await accountsModel.find({ storeId: STORE }).lean();
    for (const a of all) await accountsModel.updateOne({ _id: a._id }, { $set: { externalCode: a.code } });
    const conn: any = await integrations.saveConnection(STORE, 'odoo', { baseUrl: 'https://acme.odoo.com', database: 'acme', login: 'a@acme.com', secret: 'KEY', from: 'go_live' }, actor);
    expect(conn.lastCheck.ok).toBe(true);
    expect(conn.secretEnc).toBeUndefined();
    const total = await journal.countDocuments({ storeId: STORE });
    const r1 = await integrations.sync(STORE, 'odoo');
    expect(r1).toEqual({ sent: total - 1, failed: 1 });
    const r2 = await integrations.sync(STORE, 'odoo'); // the failed one is retried
    expect(r2).toEqual({ sent: 1, failed: 0 });
    expect((await integrations.sync(STORE, 'odoo')).sent).toBe(0);
    const log: any = await integrations.log(STORE, 'odoo', {});
    expect(log.total).toBe(total);
    expect(log.items.every((i: any) => i.status === 'sent')).toBe(true);

    const t = await integrations.tallyExport(STORE, { from: '2026-11-01', to: '2026-11-30' });
    expect(t.fileName).toBe('solvexo-tally-2026-11-01-to-2026-11-30.xml');
    expect(t.xml).toContain('<VOUCHER REMOTEID="solvexo-day:2026-11-');
    expect(t.xml).toContain('<PARENT>Cash-in-Hand</PARENT>');
  });

  it('the go-live date is locked once entries exist', async () => {
    await expect(svc.setup(STORE, { baseCurrency: 'PKR' }, { goLiveDate: '2026-11-05' }, actor)).rejects.toThrow(/cannot change/);
  });
});
