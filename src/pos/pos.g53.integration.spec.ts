/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosReceiptDeliveryService } from './pos-receipt-delivery.service';
import { PosStoreSettingsService } from './pos-store-settings.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G5.3 on a real replica-set MongoDB: receipts by e-mail / SMS (link only, consent, flags off by default, rate limits, append-only log + audit), per-store receipt-link lifetime. */
jest.setTimeout(300_000);
let h: MongoHarness; let r: any; let pos: PosService; let receipts: PosReceiptService; let delivery: PosReceiptDeliveryService; let st: PosStoreSettingsService;
const sent: any[] = [];
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, { posReceiptDeliveryModel: h.conn.model(schema.PosReceiptDelivery.name, schema.PosReceiptDeliverySchema) });
  r = h.repos;
  await r.posReceiptDeliveryModel.init();
  const dbs: any = { repositories: r };
  pos = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, pos);
  receipts = new PosReceiptService(dbs, pos);
  delivery = new PosReceiptDeliveryService(dbs, pos, auth, receipts);
  for (const ch of ['email', 'sms'] as const) delivery.setSender(ch, { send: async (storeId, to, m) => { sent.push({ ch, storeId, to, ...m }); return to.includes('fail') || to.endsWith('0000') ? { ok: false, error: 'gateway said no' } : { ok: true }; } });
  st = new PosStoreSettingsService(dbs, pos, auth);
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed) => jwt.sign({ employeeId: s.cashierId, storeId: s.storeId, role: 'cashier', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const dev = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } }, headers: { 'x-pos-employee-token': tok(s) }, params: { storeId: s.storeId }, query: {} });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' }, headers: {}, params: { storeId: s.storeId }, query: {} });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message; } };
let n = 0;
const newKey = () => `pos-${(1762851600000000 + ++n)}-0123456789abcdef01234567`;

async function world() {
  const s = await seedStore(h, { stock: 5, price: 10, baseCurrency: 'PKR' });
  const cust = new Types.ObjectId();
  await r.posCustomerModel.collection.insertOne({ _id: cust, storeId: s.storeId, name: 'Ayesha', phone: '+923001234567', email: 'ayesha@shop.pk', isDelete: false });
  const sale = new Types.ObjectId(); const KEY = newKey();
  await r.saleModel.collection.insertOne({ _id: sale, storeId: s.storeId, saleNumber: 'POS-00042', status: 'completed', items: [{ name: 'Secret item name' }], total: 1250, totalMinor: 125000, currency: 'PKR', currencyExponent: 2, customerId: String(cust), idempotencyKey: KEY, createdAt: new Date() });
  return { s, sale: String(sale), KEY };
}

describe('G5.3 · receipts by e-mail / SMS', () => {
  it('off by default (CHANNEL_OFF); the owner turns e-mail on (audited); the till reads which channels are on', async () => {
    const w = await world();
    expect((await delivery.channels(dev(w.s), w.s.storeId, { employee: tok(w.s) })).data).toEqual({ email: false, sms: false });
    expect(await code(delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'email' }, { employee: tok(w.s) }))).toBe('CHANNEL_OFF');
    await st.update(owner(w.s) as any, w.s.storeId, { connectors: { emailReceipts: true } }, {});
    expect((await delivery.channels(dev(w.s), w.s.storeId, { employee: tok(w.s) })).data).toEqual({ email: true, sms: false });
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'store_settings_changed' })).toBe(1);
  });

  it('sends ONLY the store name, the total and the public link — to the contact on file; logged (masked) and audited', async () => {
    const w = await world();
    await st.update(owner(w.s) as any, w.s.storeId, { connectors: { emailReceipts: true, smsReceipts: true } }, {});
    const d: any = (await delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'sms' }, { employee: tok(w.s) })).data;
    expect([d.consent, d.to]).toEqual(['on_file', '*********4567']);
    const m = sent.at(-1);
    expect(m.text).toMatch(new RegExp(`^Test Store: your receipt \\(PKR 1,250.00\\) — https://.+/r/s/store-${w.s.storeId}/${w.KEY}$`));
    expect(m.text).not.toContain('Secret item name');
    const log: any = await r.posReceiptDeliveryModel.findOne({ saleId: w.sale }).lean();
    expect([log.channel, log.status, log.toMasked, log.toHash.length]).toEqual(['sms', 'sent', '*********4567', 64]);
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'receipt_sent' })).toBe(1);
    await expect(r.posReceiptDeliveryModel.updateOne({ _id: log._id }, { $set: { status: 'failed' } })).rejects.toThrow(/append-only/);
  });

  it('consent: another contact needs the cashier\'s confirmation that the customer gave it for this sale; bad addresses refused', async () => {
    const w = await world();
    await st.update(owner(w.s) as any, w.s.storeId, { connectors: { emailReceipts: true } }, {});
    expect(await code(delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'email', to: 'other@mail.pk' }, { employee: tok(w.s) }))).toBe('CONSENT_REQUIRED');
    expect((await delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'email', to: 'Other@Mail.pk', consent: 'given_for_sale' }, { employee: tok(w.s) })).data.consent).toBe('given_for_sale');
    expect(sent.at(-1).to).toBe('other@mail.pk');
    expect(await code(delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'email', to: 'not-an-email', consent: 'given_for_sale' }, { employee: tok(w.s) }))).toBe('RECIPIENT_INVALID');
  });

  it('rate-limited (3 per sale per channel per hour); a failed send is logged + audited and answered SEND_FAILED', async () => {
    const w = await world();
    await st.update(owner(w.s) as any, w.s.storeId, { connectors: { emailReceipts: true, smsReceipts: true } }, {});
    for (let i = 0; i < 3; i++) await delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'email' }, { employee: tok(w.s) });
    expect(await code(delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'email' }, { employee: tok(w.s) }))).toBe('RATE_LIMITED');
    expect(await code(delivery.send(dev(w.s), w.s.storeId, w.sale, { channel: 'sms', to: '+923000000000', consent: 'given_for_sale' }, { employee: tok(w.s) }))).toBe('SEND_FAILED');
    expect(await r.posReceiptDeliveryModel.countDocuments({ saleId: w.sale, status: 'failed' })).toBe(1);
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'receipt_send_failed' })).toBe(1);
  });
});

describe('G5.3 · per-store receipt-link lifetime', () => {
  it('older than 30 days: "not available" by default; with a 90-day setting, links of sales made since then still work and older ones keep 30', async () => {
    const s = await seedStore(h, { stock: 5, price: 10 });
    const slug = `store-${s.storeId}`;
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const key = (at: Date) => `pos-${at.getTime() * 1000}-${'ab'.repeat(12)}`;
    const k40 = key(days(40));
    expect(await receipts.renderByClientKey(slug, k40)).toBeNull();
    // the owner sets 90 days; "since" is set to now → a sale made 40 days ago keeps its 30 days
    await st.update(owner(s) as any, s.storeId, { receiptLinks: { days: 90 } }, {});
    expect(await receipts.renderByClientKey(slug, k40)).toBeNull();
    // a sale made after the change (simulate: move "since" back 60 days) → still "syncing" (no data) at 40 days, refused past 90
    await r.posSettingsModel.updateOne({ storeId: s.storeId }, { $set: { receiptLinkDaysSince: days(60) } });
    expect(await receipts.renderByClientKey(slug, k40)).toBe('syncing');
    expect(await receipts.renderByClientKey(slug, key(days(95)))).toBeNull();
    expect(await code(st.update(owner(s) as any, s.storeId, { receiptLinks: { days: 10 } }, {}))).toBe('INVALID_SETTINGS');
    const read: any = (await st.get(owner(s) as any, s.storeId, {})).data;
    expect([read.receiptLinks.days, read.receiptLinks.minDays, read.connectors.fiscal]).toEqual([90, 30, false]);
  });
});
