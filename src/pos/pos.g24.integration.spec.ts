/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosReceiptService } from './pos-receipt.service';
import { PublicReceiptController } from './public-receipt.controller';
import { MongoHarness, oidStr, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/** G2.4 backend on a real replica-set MongoDB: custom items, POS coupons, the public digital receipt, refund / void / discard reasons. Price 10, USD. */
jest.setTimeout(180_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
let n = 0;
async function fresh(opts: Parameters<typeof seedStore>[1] = {}) {
  const s = await seedStore(h, { stock: 10, ...opts });
  const svc = makeService();
  const sid = String(new Types.ObjectId());
  await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
  return { s, svc, sid };
}
const dto = (s: Seed, sid: string, over: any = {}) => ({ storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: 'cash', idempotencyKey: `g24-${++n}`, ...over });
const custom = (price: number, over: any = {}) => ({ isCustom: true, customName: 'Gift wrap', unitPrice: price, qty: 1, ...over });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const coupon = (s: Seed, over: any = {}) => h.repos.couponModel.create({ scope: 'seller', storeId: s.storeId, sellerId: s.sellerId, code: `C${++n}`, discountType: 'percentage', discountValue: 10, posEnabled: true, isActive: true, currency: 'USD', ...over });
const audits = (storeId: string, action: string) => h.repos.posAuditLogModel.find({ storeId, action }).lean();

describe('custom item', () => {
  it('a manager approves it: no product, never touches stock, stamped with the approver, audited, counted in the shift', async () => {
    const { s, svc, sid } = await fresh();
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [custom(30, { qty: 2, taxCategory: 'standard' })] }) as any, tok(s, 'manager'));
    const it = res.data.items[0];
    expect(it).toMatchObject({ isCustom: true, name: 'Gift wrap', sku: 'CUSTOM', productId: null, variantId: null, price: 30, qty: 2, lineTotal: 60, lineTotalMinor: 6000, customApprovedBy: s.managerId });
    expect(res.data.total).toBe(60);
    expect(await stockOf(h, s.variantId)).toBe(10);
    const log: any = (await audits(s.storeId, 'custom_item_sold'))[0];
    expect(log.metadata).toMatchObject({ name: 'Gift wrap', qty: 2, priceMinor: 3000, approvedBy: s.managerId });
    expect(((await audits(s.storeId, 'sale_created'))[0] as any).metadata).toMatchObject({ customItems: 1, customItemsTotalMinor: 6000, customItemsApprovedBy: s.managerId });
    expect(((await h.repos.registerSessionModel.findById(sid).lean()) as any).cashSales).toBe(60);
  });

  it('without a manager it is refused (limit null = always) and nothing is sold; a cashier token is not enough', async () => {
    const { s, svc, sid } = await fresh();
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { items: [custom(5)] }) as any, undefined))).toBe('CUSTOM_ITEM_NEEDS_MANAGER');
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { items: [custom(5)] }) as any, tok(s, 'cashier')))).toBe('CUSTOM_ITEM_NEEDS_MANAGER');
    expect(await h.repos.saleModel.countDocuments({ storeId: s.storeId })).toBe(0);
  });

  it('the store sets the limit: a cashier may add one up to it, above it a manager must approve', async () => {
    const { s, svc, sid } = await fresh();
    await h.repos.posSettingsModel.collection.updateOne({ storeId: s.storeId }, { $set: { customItemApprovalAboveMinor: 5000 } }, { upsert: true });
    const ok: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [custom(50)] }) as any, tok(s, 'cashier'));
    expect(ok.data.items[0].customApprovedBy).toBeNull();
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { items: [custom(50.01)] }) as any, tok(s, 'cashier')))).toBe('CUSTOM_ITEM_NEEDS_MANAGER');
    const mg: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [custom(500)] }) as any, tok(s, 'manager'));
    expect(mg.data.items[0].customApprovedBy).toBe(s.managerId);
  });

  it('needs a name and a price; an exempt item carries no tax while a catalog item beside it does', async () => {
    const { s, svc, sid } = await fresh({ taxRate: 0.1 });
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { items: [custom(0)] }) as any, tok(s, 'manager')))).toBe('CUSTOM_ITEM_PRICE_REQUIRED');
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { items: [custom(5, { customName: '  ' })] }) as any, tok(s, 'manager')))).toBe('CUSTOM_ITEM_NAME_REQUIRED');
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }, custom(10, { taxCategory: 'exempt' })] }) as any, tok(s, 'manager'));
    expect(res.data).toMatchObject({ subtotal: 20, tax: 1, total: 21 }); // tax only on the 10.00 catalog line
    expect(res.data.items[1].taxCategory).toBe('exempt');
    // a discount is shared out: 50% off → tax base = 10 − 5 = 5 → tax 0.50
    const d: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }, custom(10, { taxCategory: 'exempt' })], discountType: 'percent', discountValue: 50 }) as any, tok(s, 'manager'));
    expect(d.data).toMatchObject({ subtotal: 20, discount: 10, tax: 0.5, total: 10.5 });
  });

  it('refund and void give stock back only for catalog lines; the custom line refunds like any other; reports show "Custom item"', async () => {
    const { s, svc, sid } = await fresh();
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }, custom(15)] }) as any, tok(s, 'manager'));
    expect(await stockOf(h, s.variantId)).toBe(8);
    const customId = String(res.data.items[1]._id);
    const part: any = await svc.refundSale(s.sellerId, String(res.data._id), { items: [{ saleItemId: customId, qty: 1 }], reasonCode: 'wrong_item' } as any, tok(s, 'manager'));
    expect(part.data.refundedAmount).toBe(15);
    expect(await stockOf(h, s.variantId)).toBe(8); // nothing to restore for the custom line
    await svc.voidSale(s.sellerId, String((await svc.createSale(s.sellerId, dto(s, sid, { items: [custom(7)] }) as any, tok(s, 'manager')) as any).data._id), { reasonCode: 'cashier_error' }, tok(s, 'manager'));
    const rep: any = await svc.getSessionReport(s.sellerId, sid);
    expect(rep.data.summary.customItems).toMatchObject({ count: 1, total: 15 });
    const day: any = await svc.getDailyReport(s.sellerId, s.storeId as any, {});
    expect(day.data.topProducts.find((p: any) => p.name === 'Custom item')).toMatchObject({ qty: 1, revenue: 15 });
  });

  it('a held sale may carry one; completing it needs no stock for that line', async () => {
    const { s, svc, sid } = await fresh();
    const held: any = await svc.createSale(s.sellerId, dto(s, sid, { status: 'held', items: [custom(12)] }) as any, tok(s, 'manager'));
    const done: any = await svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'cash' } as any, tok(s, 'manager'));
    expect(done.data).toMatchObject({ status: 'completed', total: 12 });
    expect(await stockOf(h, s.variantId)).toBe(10);
  });
});

describe('POS coupons (storefront Coupon model, POS channel)', () => {
  it('percentage and fixed coupons discount the sale; the usage is counted once per completed sale', async () => {
    const { s, svc, sid } = await fresh({ taxRate: 0.1 });
    const pc = await coupon(s, { code: 'TEN', discountType: 'percentage', discountValue: 10 });
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'ten', items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] }) as any, undefined);
    expect(res.data).toMatchObject({ subtotal: 20, discount: 2, tax: 1.8, total: 19.8, couponCode: 'TEN', couponDiscountMinor: 200 });
    expect(((await h.repos.couponModel.findById(pc._id).lean()) as any).usageCount).toBe(1);
    await coupon(s, { code: 'FIVE', discountType: 'fixed', discountValue: 5 });
    const fx: any = await svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'FIVE' }) as any, undefined);
    expect(fx.data).toMatchObject({ discount: 5, total: 5.5 });
    await coupon(s, { code: 'HUGE', discountType: 'fixed', discountValue: 500 });
    const hg: any = await svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'HUGE', paymentMethod: 'cash' }) as any, undefined);
    expect(hg.data).toMatchObject({ discount: 10, total: 0 }); // never more than the subtotal
  });

  it('every rule: POS channel off, other store, platform scope, inactive, deleted, not started, expired, limit reached, minimum spend, currency', async () => {
    const { s, svc, sid } = await fresh();
    const other = await seedStore(h, { stock: 5 });
    const day = 86400_000;
    const cases: Array<[string, any, string]> = [
      ['OFF', { posEnabled: false }, 'COUPON_INVALID'],
      ['INACTIVE', { isActive: false }, 'COUPON_INVALID'],
      ['DELETED', { isDelete: true }, 'COUPON_INVALID'],
      ['PLATFORM', { scope: 'platform', storeId: null }, 'COUPON_INVALID'],
      ['LATER', { startsAt: new Date(Date.now() + day) }, 'COUPON_NOT_STARTED'],
      ['OLD', { expiresAt: new Date(Date.now() - day) }, 'COUPON_EXPIRED'],
      ['USEDUP', { usageLimit: 3, usageCount: 3 }, 'COUPON_LIMIT_REACHED'],
      ['MIN', { minOrderAmount: 50 }, 'COUPON_MIN_SPEND'],
      ['EUR', { discountType: 'fixed', discountValue: 1, currency: 'EUR' }, 'COUPON_CURRENCY_MISMATCH'],
    ];
    for (const [c, over, expected] of cases) {
      await coupon(s, { code: c, ...over });
      expect({ c, got: await code(svc.createSale(s.sellerId, dto(s, sid, { couponCode: c }) as any, undefined)) }).toEqual({ c, got: expected });
    }
    await coupon(other, { code: 'THEIRS' });
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'THEIRS' }) as any, undefined))).toBe('COUPON_INVALID');
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'NOPE' }) as any, undefined))).toBe('COUPON_INVALID');
    expect(await h.repos.saleModel.countDocuments({ storeId: s.storeId })).toBe(0);
    expect(await stockOf(h, s.variantId)).toBe(10);
  });

  it('one coupon per sale and never with a manual discount; not on offline sales', async () => {
    const { s, svc, sid } = await fresh();
    await coupon(s, { code: 'ONE' });
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'ONE', discountType: 'amount', discountValue: 1 }) as any, tok(s, 'manager')))).toBe('COUPON_WITH_DISCOUNT');
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'ONE', offline: true, clientCreatedAt: new Date().toISOString() }) as any, undefined))).toBe('COUPON_ONLINE_ONLY');
  });

  it('a sale that fails after the coupon check (not enough stock) does not use the coupon up', async () => {
    const { s, svc, sid } = await fresh({ stock: 1 });
    const c = await coupon(s, { code: 'KEEP', usageLimit: 1 });
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'KEEP', items: [{ productId: s.productId, variantId: s.variantId, qty: 5 }] }) as any, undefined))).toBeTruthy();
    expect(((await h.repos.couponModel.findById(c._id).lean()) as any).usageCount).toBe(0);
  });

  it('USAGE-LIMIT RACE: two tills use the last redemption at the same moment — exactly one sale, the other refused, stock handed back', async () => {
    const { s, svc, sid } = await fresh({ stock: 10 });
    const c = await coupon(s, { code: 'LAST', usageLimit: 1 });
    const results = await Promise.allSettled([
      svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'LAST' }) as any, undefined),
      svc.createSale(s.sellerId, dto(s, sid, { couponCode: 'LAST' }) as any, undefined),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost: any = results.find((r) => r.status === 'rejected');
    expect(lost.reason?.response?.code).toBe('COUPON_LIMIT_REACHED');
    expect(((await h.repos.couponModel.findById(c._id).lean()) as any).usageCount).toBe(1);
    expect(await h.repos.saleModel.countDocuments({ storeId: s.storeId })).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(9);
  });

  it('quote shows the coupon\'s effect without selling or counting; errors come back as codes', async () => {
    const { s, svc } = await fresh();
    const c = await coupon(s, { code: 'Q10' });
    const q: any = await svc.quoteSale(s.sellerId, { storeId: s.storeId, items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], couponCode: 'q10' } as any);
    expect(q.data.totals ?? q.data).toMatchObject({ discount: 2 });
    expect(q.data.coupon).toMatchObject({ code: 'Q10' }); // the app shows which coupon applied and how it discounts
    expect(((await h.repos.couponModel.findById(c._id).lean()) as any).usageCount).toBe(0);
    expect(await code(svc.quoteSale(s.sellerId, { storeId: s.storeId, items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], couponCode: 'NOPE' } as any))).toBe('COUPON_INVALID');
  });
});

describe('digital receipt', () => {
  async function app(svc: PosService) {
    const receipts = new PosReceiptService({ repositories: h.repos } as any, svc);
    const mod = await Test.createTestingModule({ controllers: [PublicReceiptController], providers: [{ provide: PosReceiptService, useValue: receipts }] }).compile();
    const a = mod.createNestApplication(); await a.init();
    return { receipts, a };
  }
  const sell = async (x: Awaited<ReturnType<typeof fresh>>, over: any = {}) => ((await x.svc.createSale(x.s.sellerId, dto(x.s, x.sid, over) as any, tok(x.s, 'manager'))) as any).data;

  it('the token is 192 random bits, unique per sale, stable until revoked, and two taps make ONE link', async () => {
    const x = await fresh(); const { receipts, a } = await app(x.svc);
    const s1 = await sell(x); const s2 = await sell(x);
    const [l1, l1b] = await Promise.all([receipts.getLink(x.s.sellerId, String(s1._id)), receipts.getLink(x.s.sellerId, String(s1._id))]);
    expect(l1.data.path).toBe(l1b.data.path);
    const t1 = l1.data.path.slice(3);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 bytes → 32 base64url characters = 192 bits
    expect((await receipts.getLink(x.s.sellerId, String(s2._id))).data.path).not.toBe(l1.data.path);
    expect(Buffer.from(t1, 'base64url').length).toBe(24);
    await a.close();
  });

  it('the public page shows the store, items, totals, how it was paid and the refund status — and nothing about the customer', async () => {
    const x = await fresh({ taxRate: 0.1 }); const { receipts, a } = await app(x.svc);
    await h.repos.posSettingsModel.collection.updateOne({ storeId: x.s.storeId }, { $set: { businessName: 'Dev Coffee', businessAddress: '1 Dev Street', businessTaxId: 'TAX-9', receiptFooter: 'Thanks!' } }, { upsert: true });
    const sale = await sell(x, { customerName: 'Secret Person', customerId: oidStr(), notes: 'call 0300-1234567', items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }, custom(5, { customName: '<script>alert(1)</script>' })], payments: [{ method: 'card', amount: 10, reference: 'AUTH-777' }, { method: 'cash', amount: 17.5, tendered: 20 }], paymentMethod: 'card' });
    const token = (await receipts.getLink(x.s.sellerId, String(sale._id))).data.path.slice(3);
    const res = await request(a.getHttpServer()).get(`/r/${token}`).expect(200);
    const html: string = res.text;
    for (const must of ['Dev Coffee', '1 Dev Street', 'TAX-9', sale.saleNumber, 'Tea', '2 × USD 10.00', 'USD 25.00', 'Total', 'USD 27.50', 'Card', 'Cash', 'Thanks!', 'Paid']) expect(html).toContain(must);
    for (const mustNot of ['Secret Person', '0300-1234567', 'AUTH-777', 'Mia Manager', 'Cal Cashier', String(x.s.managerId), String(sale._id), x.s.storeId, '<script>alert']) expect({ mustNot, found: html.includes(mustNot) }).toEqual({ mustNot, found: false });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); // the custom item name is escaped
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    await a.close();
  });

  it('refund status is shown on the page', async () => {
    const x = await fresh(); const { receipts, a } = await app(x.svc);
    const sale = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }] });
    const token = (await receipts.getLink(x.s.sellerId, String(sale._id))).data.path.slice(3);
    await x.svc.refundSale(x.s.sellerId, String(sale._id), { items: [{ saleItemId: String(sale.items[0]._id), qty: 1 }] } as any, tok(x.s, 'manager'));
    expect((await request(a.getHttpServer()).get(`/r/${token}`)).text).toContain('Partially refunded');
    await x.svc.refundSale(x.s.sellerId, String(sale._id), undefined, tok(x.s, 'manager'));
    expect((await request(a.getHttpServer()).get(`/r/${token}`)).text).toContain('Fully refunded');
    await a.close();
  });

  it('REVOCATION: after a manager revokes it the link answers the same plain 404 as an unknown or malformed one; a new link is a new token', async () => {
    const x = await fresh(); const { receipts, a } = await app(x.svc);
    const sale = await sell(x);
    const t1 = (await receipts.getLink(x.s.sellerId, String(sale._id))).data.path.slice(3);
    await request(a.getHttpServer()).get(`/r/${t1}`).expect(200);
    expect((await receipts.revoke(x.s.sellerId, String(sale._id), x.s.managerId)).data.revoked).toBe(true);
    const gone = await request(a.getHttpServer()).get(`/r/${t1}`).expect(404);
    const unknown = await request(a.getHttpServer()).get(`/r/${'A'.repeat(32)}`).expect(404);
    const malformed = await request(a.getHttpServer()).get('/r/short').expect(404);
    expect(gone.text).toBe(unknown.text); expect(gone.text).toBe(malformed.text);
    const t2 = (await receipts.getLink(x.s.sellerId, String(sale._id))).data.path.slice(3);
    expect(t2).not.toBe(t1);
    await request(a.getHttpServer()).get(`/r/${t2}`).expect(200);
    await request(a.getHttpServer()).get(`/r/${t1}`).expect(404);
    expect(await audits(x.s.storeId, 'receipt_link_revoked')).toHaveLength(1);
    await a.close();
  });

  it('a held sale has no receipt; another store\'s seller cannot get a link', async () => {
    const x = await fresh(); const { receipts, a } = await app(x.svc);
    const held = await sell(x, { status: 'held' });
    await expect(receipts.getLink(x.s.sellerId, String(held._id))).rejects.toMatchObject({ status: 404 });
    const sale = await sell(x);
    await expect(receipts.getLink(oidStr(), String(sale._id))).rejects.toMatchObject({ status: 403 });
    await a.close();
  });
});

describe('reasons (picker + optional note)', () => {
  it('refund: the code and note are stored on the refund record and the audit event; old builds (text only) still work', async () => {
    const { s, svc, sid } = await fresh();
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] }) as any, undefined);
    const itemId = String(sale.data.items[0]._id);
    await svc.refundSale(s.sellerId, String(sale.data._id), { items: [{ saleItemId: itemId, qty: 1 }], reasonCode: 'damaged_or_defective', reason: 'cracked lid' } as any, tok(s, 'manager'));
    await svc.refundSale(s.sellerId, String(sale.data._id), { reason: 'old build text' } as any, tok(s, 'manager'));
    const rows: any[] = await h.repos.posRefundModel.find({ saleId: String(sale.data._id) }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => [r.reasonCode, r.reason])).toEqual([['damaged_or_defective', 'cracked lid'], ['not_provided', 'old build text']]);
    const a: any = (await audits(s.storeId, 'sale_refunded_partial'))[0];
    expect(a.metadata).toMatchObject({ reasonCode: 'damaged_or_defective', reason: 'cracked lid' });
  });

  it('an unknown code is refused; "other" needs words', async () => {
    const { s, svc, sid } = await fresh();
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid) as any, undefined);
    expect(await code(svc.refundSale(s.sellerId, String(sale.data._id), { reasonCode: 'because' } as any, tok(s, 'manager')))).toBe('INVALID_REASON_CODE');
    expect(await code(svc.refundSale(s.sellerId, String(sale.data._id), { reasonCode: 'other' } as any, tok(s, 'manager')))).toBe('REASON_NOTE_REQUIRED');
    expect(await code(svc.voidSale(s.sellerId, String(sale.data._id), { reasonCode: 'nope' }, tok(s, 'manager')))).toBe('INVALID_REASON_CODE');
    expect(((await h.repos.saleModel.findById(sale.data._id).lean()) as any).status).toBe('completed');
  });

  it('void and held-sale discard store the code and note and audit them', async () => {
    const { s, svc, sid } = await fresh();
    const a: any = await svc.createSale(s.sellerId, dto(s, sid) as any, undefined);
    await svc.voidSale(s.sellerId, String(a.data._id), { reasonCode: 'wrong_total', reason: 'typed 10 not 100' }, tok(s, 'manager'));
    expect(await h.repos.saleModel.findById(a.data._id).lean()).toMatchObject({ status: 'voided', voidReasonCode: 'wrong_total', voidReason: 'typed 10 not 100' });
    expect(((await audits(s.storeId, 'sale_voided'))[0] as any).metadata).toMatchObject({ reasonCode: 'wrong_total' });
    const held: any = await svc.createSale(s.sellerId, dto(s, sid, { status: 'held' }) as any, undefined);
    await svc.discardHeldSale(s.sellerId, String(held.data._id), { reasonCode: 'customer_left', employeeToken: tok(s, 'cashier') });
    expect(await h.repos.saleModel.findById(held.data._id).lean()).toMatchObject({ status: 'discarded', deleteReasonCode: 'customer_left', deleteReason: 'customer left' });
    expect(((await audits(s.storeId, 'held_sale_discarded'))[0] as any).metadata).toMatchObject({ reasonCode: 'customer_left' });
    const held2: any = await svc.createSale(s.sellerId, dto(s, sid, { status: 'held' }) as any, undefined);
    await svc.discardHeldSale(s.sellerId, String(held2.data._id), { reason: 'old build' });
    expect(await h.repos.saleModel.findById(held2.data._id).lean()).toMatchObject({ deleteReasonCode: 'not_provided', deleteReason: 'old build' });
  });
});
