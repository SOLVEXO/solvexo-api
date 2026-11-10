/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosCatalogAdminService } from './pos-catalog-admin.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { moneyContractViolations } from './testing/money-contract';

/** G4.5 on a real replica-set MongoDB: modifiers and price books priced by the SERVER at sale and quote; the admin endpoints behind the matrix. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let admin: PosCatalogAdminService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, { posModifierGroupModel: h.conn.model(schema.PosModifierGroup.name, schema.PosModifierGroupSchema), posPriceBookModel: h.conn.model(schema.PosPriceBook.name, schema.PosPriceBookSchema) });
  r = h.repos;
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  admin = new PosCatalogAdminService(dbs, svc, new PosAuthorizer(dbs, svc), {} as any, {} as any, {} as any);
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

async function world() {
  const s = await seedStore(h, { stock: 100, price: 5, baseCurrency: 'USD', taxRate: 0.1 }); // 5.00 latte
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(), openingCash: 10, totalSales: 0, totalTransactions: 0 });
  const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
  const size = (await admin.modifierCreate(device(s), s.storeId, { name: 'Size', minSelect: 1, maxSelect: 1, productIds: [s.productId], options: [{ name: 'Small', priceDeltaMinor: 0 }, { name: 'Large', priceDeltaMinor: 100 }] }, M)).data.group;
  const extras = (await admin.modifierCreate(device(s), s.storeId, { name: 'Extras', minSelect: 0, maxSelect: 2, productIds: [s.productId], options: [{ name: 'Extra shot', priceDeltaMinor: 80 }, { name: 'Oat milk', priceDeltaMinor: 60 }] }, M)).data.group;
  const opt = (g: any, name: string) => g.options.find((o: any) => o.name === name).id;
  const line = (mods: any[], qty = 1) => ({ productId: s.productId, variantId: s.variantId, qty, modifiers: mods });
  const sell = async (items: any[], over: any = {}) => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items, paymentMethod: 'card', ...over } as any, tok(s, 'manager'))) as any).data;
  return { s, sid, M, C, size, extras, opt, line, sell };
}

describe('modifiers at sale (server-priced)', () => {
  it('a Large latte with an extra shot: 5.00 + 1.00 + 0.80 = 6.80 per cup; the line names the choices; tax on the full price; quote = sale', async () => {
    const w = await world();
    const mods = [{ groupId: w.size.id, optionIds: [w.opt(w.size, 'Large')] }, { groupId: w.extras.id, optionIds: [w.opt(w.extras, 'Extra shot')] }];
    const q: any = (await svc.quoteSale(w.s.sellerId, { storeId: w.s.storeId, items: [w.line(mods, 2)] } as any)).data;
    const sale = await w.sell([w.line(mods, 2)]);
    expect(sale.items[0].price).toBe(6.8);
    expect(sale.items[0].name).toBe('Tea (Large, Extra shot)');
    expect(sale.items[0].modifiers.map((m: any) => [m.groupName, m.name, m.priceDeltaMinor])).toEqual([['Size', 'Large', 100], ['Extras', 'Extra shot', 80]]);
    expect(sale.items[0].basePriceMinor).toBe(500);
    expect([sale.subtotal, sale.tax, sale.total]).toEqual([13.6, 1.36, 14.96]);
    expect(q.total ?? q.totals?.total).toBe(14.96);
  });
  it('rules are enforced online: a required size, at most two extras, an option of another product', async () => {
    const w = await world();
    expect(await code(w.sell([w.line([])]))).toBe('MODIFIER_REQUIRED');
    expect(await code(w.sell([w.line([{ groupId: w.size.id, optionIds: [w.opt(w.size, 'Small')] }, { groupId: w.extras.id, optionIds: [w.opt(w.extras, 'Extra shot'), w.opt(w.extras, 'Oat milk'), w.opt(w.extras, 'Extra shot') + 'x'] }])]))).toBe('MODIFIER_TOO_MANY');
    expect(await code(w.sell([w.line([{ groupId: w.size.id, optionIds: [w.opt(w.size, 'Small') + 'x'] }])]))).toBe('MODIFIER_OPTION_UNKNOWN');
    const other = await world();
    expect(await code(w.sell([w.line([{ groupId: other.size.id, optionIds: [other.opt(other.size, 'Large')] }])]))).toBe('MODIFIER_NOT_ON_PRODUCT');
    expect(await code(svc.quoteSale(w.s.sellerId, { storeId: w.s.storeId, items: [w.line([])] } as any))).toBe('MODIFIER_REQUIRED');
  });
  it('offline: never refused; the till\'s price is recorded and verified when it matches the server\'s price for the same choices', async () => {
    const w = await world();
    const mods = [{ groupId: w.size.id, optionIds: [w.opt(w.size, 'Large')] }];
    const off = (unitPrice: number, key: string) => w.sell([{ ...w.line(mods), unitPrice }], { offline: true, clientCreatedAt: new Date(Date.now() - 60_000).toISOString(), idempotencyKey: key, provisionalNumber: undefined });
    const ok = await off(6, rk());
    expect([ok.items[0].price, ok.items[0].priceVerified]).toEqual([6, true]);
    const odd = await off(5.5, rk());
    expect([odd.items[0].price, odd.items[0].priceVerified]).toEqual([5.5, false]);
  });
});
const rk = () => `k-${Math.random().toString(36).slice(2)}`;

describe('price books', () => {
  it('picked at checkout: listed variants at the book price (modifier deltas still add); not listed = list price; customer\'s book applies by itself; out of its window = refused', async () => {
    const w = await world();
    const book = (await admin.priceBookCreate(device(w.s), w.s.storeId, { name: 'Wholesale', entries: [{ variantId: w.s.variantId, priceMinor: 400 }] }, w.M)).data.book;
    const small = [{ groupId: w.size.id, optionIds: [w.opt(w.size, 'Small')] }];
    const sale = await w.sell([w.line(small)], { priceBookId: book.id });
    expect([sale.items[0].price, sale.items[0].basePriceMinor, sale.priceBookName]).toEqual([4, 400, 'Wholesale']);
    // a customer assigned to the book
    const cust = await r.posCustomerModel.create({ storeId: w.s.storeId, name: 'Shop owner', phone: '0300' + Math.floor(Math.random() * 1e7) });
    await admin.assignBook(device(w.s), w.s.storeId, String(cust._id), { priceBookId: book.id }, w.M);
    const viaCustomer = await w.sell([w.line(small)], { customerId: String(cust._id) });
    expect(viaCustomer.items[0].price).toBe(4);
    // out of window
    await admin.priceBookUpdate(device(w.s), w.s.storeId, book.id, { endsAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() - 86_400_000).toISOString() }, w.M);
    expect(await code(w.sell([w.line(small)], { priceBookId: book.id }))).toBe('PRICE_BOOK_NOT_ACTIVE');
    expect((await w.sell([w.line(small)], { customerId: String(cust._id) })).items[0].price).toBe(5); // the customer's expired book is ignored
  });
});

describe('admin endpoints (matrix + validation + money contract)', () => {
  it('a cashier may read modifiers / price books (to sell) but not edit them; validation; every response states currency', async () => {
    const w = await world();
    expect((await admin.modifierGroups(device(w.s), w.s.storeId, { productId: w.s.productId }, w.C)).data.groups).toHaveLength(2);
    expect(await code(admin.modifierCreate(device(w.s), w.s.storeId, { name: 'X', options: [{ name: 'a' }] }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(admin.modifierCreate(device(w.s), w.s.storeId, { name: 'X', minSelect: 3, maxSelect: 2, options: [{ name: 'a' }] }, w.M))).toBe('INVALID_GROUP');
    expect(await code(admin.modifierCreate(device(w.s), w.s.storeId, { name: 'X', minSelect: 2, maxSelect: 2, options: [{ name: 'a' }] }, w.M))).toBe('INVALID_GROUP');
    expect(await code(admin.priceBookCreate(device(w.s), w.s.storeId, { name: 'B', entries: [{ variantId: String(new Types.ObjectId()), priceMinor: 1 }] }, w.M))).toBe('VARIANT_NOT_FOUND');
    expect(await code(admin.priceBookCreate(device(w.s), w.s.storeId, { name: 'B', entries: [{ variantId: w.s.variantId, priceMinor: 1.5 }] }, w.M))).toBe('INVALID_AMOUNT');
    expect(await code(admin.priceBookCreate(device(w.s), w.s.storeId, { name: 'B', entries: [] }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    const out = [(await admin.modifierGroups(device(w.s), w.s.storeId, {}, w.C)).data, (await admin.priceBooks(device(w.s), w.s.storeId, w.C)).data];
    out.forEach((x) => expect(moneyContractViolations(x)).toEqual([]));
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'modifier_group_created' })).toBe(2);
  });
  it('add a variant (same attributes, unique SKU) and archive one (never the last)', async () => {
    const w = await world();
    const m = (await admin.addVariant(device(w.s), w.s.storeId, w.s.productId, { priceMinor: 650, sku: 'TEA-2', options: [] }, w.M).then(() => null, (e) => e?.response?.code));
    expect(m).toBe('VARIANT_EXISTS'); // the seeded variant already has no attributes
    expect(await code(admin.archiveVariant(device(w.s), w.s.storeId, w.s.productId, w.s.variantId, w.M))).toBe('LAST_VARIANT');
  });
});
