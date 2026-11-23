/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { startMongoHarness, MongoHarness } from '../pos/testing/mongo-harness';
import { KhataAccount, KhataAccountSchema, KhataEntry, KhataEntrySchema } from '../khata/khata.schema';
import { AccountingSettings, AccountingSettingsSchema, JournalEntry, JournalEntrySchema, LedgerAccount, LedgerAccountSchema } from './accounting.schema';
import { AccountingService } from './accounting.service';
import { AccountingSyncService } from './accounting-sync.service';
import { DEFAULT_ACCOUNTS } from './chart.const';

jest.setTimeout(120_000);

let h: MongoHarness;
let svc: AccountingService;
let sync: AccountingSyncService;
let journal: any;
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
  };
  h.repos.posExpenseModel = repos.posExpenseModel;
  h.repos.posExpenseEventModel = repos.posExpenseEventModel;
  const redis: any = { withLock: async (_k: string, _t: number, fn: () => Promise<void>) => { await fn(); return 'ran'; } };
  svc = new AccountingService(accounts as any, settings as any, journal);
  sync = new AccountingSyncService({ repositories: repos } as any, redis, svc, settings as any, journal, m(KhataEntry, KhataEntrySchema) as any, m(KhataAccount, KhataAccountSchema) as any);
  await svc.setup(STORE, { baseCurrency: 'PKR' }, { goLiveDate: GO_LIVE }, actor);
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
    await raw(h.repos.posExpenseModel).insertOne({ _id: expenseId, storeId: STORE, number: 'EXP-1', seq: 1, category: 'utilities', amountMinor: 250000, currency: 'PKR', currencyExponent: 2, method: 'cash', occurredAt: new Date('2026-11-11'), createdAt: new Date('2026-11-11') });

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

  it('the go-live date is locked once entries exist', async () => {
    await expect(svc.setup(STORE, { baseCurrency: 'PKR' }, { goLiveDate: '2026-11-05' }, actor)).rejects.toThrow(/cannot change/);
  });
});
