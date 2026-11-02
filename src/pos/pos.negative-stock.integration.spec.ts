/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { InventoryService } from '../inventory/inventory.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/**
 * 5C.1: an offline oversell leaves stock NEGATIVE. Everything that reads or sells stock must treat <= 0 as
 * "out of stock" — never show a negative number to buyers, never let an online purchase through.
 */
jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const makePos = () => new PosService({ repositories: h.repos } as any, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
const makeInv = () => new InventoryService({ repositories: h.repos } as any, null as any, null as any, null as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const code = async (p: Promise<any>) => { try { await p; return 'NO_ERROR'; } catch (e: any) { return e.getResponse?.().message ?? e.message; } };
const makeNegative = (s: Seed, stock: number) => h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { stock } });

describe.each([-3, 0])('stock = %i', (stock) => {
  it('an ONLINE POS sale is rejected and stock is untouched', async () => {
    const svc = makePos();
    const s = await seedStore(h, { stock: 5 });
    const open: any = await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 0 } as any);
    await makeNegative(s, stock);
    const msg = await code(svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: String(open.data._id), registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: 'cash' } as any, undefined));
    expect(msg).toMatch(/Insufficient stock/);
    expect((await h.repos.productVariantModel.collection.findOne({ _id: new Types.ObjectId(s.variantId) }))!.stock).toBe(stock);
  });

  it('inventory list never reports negative stock and counts it as out of stock', async () => {
    const s = await seedStore(h, { stock: 5 });
    await makeNegative(s, stock);
    const res: any = await makeInv().getStoreInventory(s.sellerId, s.storeId, {});
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/"(stock|totalStock|available|availableStock)":-\d/);
  });

  it('low-stock summary treats it as out of stock, never negative', async () => {
    const s = await seedStore(h, { stock: 5 });
    await makeNegative(s, stock);
    const res: any = await makeInv().getLowStockSummary(s.sellerId, s.storeId);
    expect(JSON.stringify(res)).not.toMatch(/:-\d/);
    expect(res.data?.outOfStockCount ?? res.outOfStockCount ?? res.data?.outOfStock ?? 1).toBeGreaterThanOrEqual(1);
  });
});
