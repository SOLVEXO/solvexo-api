/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { SellerAccountDeletionService, DELETION_GRACE_DAYS } from './seller-account-deletion.service';
import { PosDeviceService } from '../pos/pos-device.service';
import { PosTokenRevocationService } from '../pos/pos-token-revocation.service';
import { RedisService } from '../redis/redis.service';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5F: seller account deletion against a REAL Mongo (+ Redis for token revocation). */
jest.setTimeout(120_000);
const DAY = 86_400_000;
let h: MongoHarness;
let redis: RedisService;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  redis = new RedisService();
  await redis.onModuleInit();
});
afterAll(async () => { await redis?.onModuleDestroy(); await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const svc = () => new SellerAccountDeletionService({ repositories: h.repos } as any, new PosTokenRevocationService(redis));
async function seedSeller(s: { sellerId: string }, password: string | null = 'pw-12345') {
  await h.repos.sellerModel.collection.insertOne({ _id: new Types.ObjectId(s.sellerId), name: 'Olive Owner', email: `olive-${s.sellerId}@x.com`, role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, phone: '555-0100', address: '1 Main', password: password ? await bcrypt.hash(password, 4) : null, providerId: 'g-123', authProvider: 'google', fcmToken: 'fcm', profileImage: 'p.png' });
}
const seller = async (id: string): Promise<any> => h.repos.sellerModel.collection.findOne({ _id: new Types.ObjectId(id) });

describe('request', () => {
  it('needs the right password; a social-only account is told to use the web', async () => {
    const s = await seedStore(h); await seedSeller(s);
    await expect(svc().request(s.sellerId, 'wrong')).rejects.toMatchObject({ response: { code: 'INVALID_PASSWORD' } });
    await expect(svc().request(s.sellerId, undefined)).rejects.toMatchObject({ response: { code: 'INVALID_PASSWORD' } });
    expect((await seller(s.sellerId)).status).toBe('active');
    const t = await seedStore(h); await seedSeller(t, null);
    await expect(svc().request(t.sellerId, 'anything')).rejects.toMatchObject({ response: { code: 'PASSWORD_REQUIRED_FOR_DELETION' } });
  });

  it('is refused while a register shift is open', async () => {
    const s = await seedStore(h); await seedSeller(s);
    await h.repos.registerSessionModel.collection.insertOne({ storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
    await expect(svc().request(s.sellerId, 'pw-12345')).rejects.toMatchObject({ response: { code: 'ACCOUNT_HAS_OPEN_SESSIONS' } });
  });

  it('schedules the purge, revokes sessions + every device + PIN sessions, suspends the stores, audits — and can be cancelled', async () => {
    const s = await seedStore(h); await seedSeller(s);
    const devices = new PosDeviceService({ repositories: h.repos } as any);
    const dev = (await devices.register(s.sellerId, { storeId: s.storeId, registerId: s.registerId, name: 'Till' })).data;
    const res: any = await svc().request(s.sellerId, 'pw-12345');
    expect(res.data.graceDays).toBe(DELETION_GRACE_DAYS);
    const sel = await seller(s.sellerId);
    expect(sel).toMatchObject({ status: 'pending_deletion', tokenVersion: 1 });
    expect(Math.round((new Date(sel.deletionScheduledFor).getTime() - Date.now()) / DAY)).toBe(DELETION_GRACE_DAYS);
    expect((await h.repos.storeModel.collection.findOne({ _id: new Types.ObjectId(s.storeId) }) as any).status).toBe('suspended');
    expect((await h.repos.posDeviceModel.findById(dev.deviceId).lean() as any).status).toBe('revoked');
    await expect(devices.verifyToken(dev.deviceToken)).rejects.toMatchObject({ response: { code: 'POS_DEVICE_REVOKED' } });
    // a manager PIN session that existed before is dead
    const rv = new PosTokenRevocationService(redis);
    expect(await rv.isRevoked({ employeeId: s.managerId, iatMs: Date.now() - 1000 })).toBe(true);
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'account_deletion_requested' })).toBe(1);

    expect((await svc().status(s.sellerId) as any).data.pending).toBe(true);
    await svc().cancel(s.sellerId);
    expect((await seller(s.sellerId)).status).toBe('active');
    expect((await h.repos.storeModel.collection.findOne({ _id: new Types.ObjectId(s.storeId) }) as any).status).toBe('active');
  });
});

describe('purge', () => {
  it('does nothing before the grace period ends', async () => {
    const s = await seedStore(h); await seedSeller(s);
    await svc().request(s.sellerId, 'pw-12345');
    expect(await svc().purgeDue(new Date(Date.now() + 10 * DAY))).toBe(0);
    expect((await seller(s.sellerId)).status).toBe('pending_deletion');
  });

  it('de-identifies people but KEEPS the sales/tax records', async () => {
    const s = await seedStore(h); await seedSeller(s);
    await h.repos.employeeModel.collection.updateOne({ _id: new Types.ObjectId(s.cashierId) }, { $set: { pin: 'hash', phone: '555-0199' } });
    const saleId = new Types.ObjectId();
    await h.repos.saleModel.collection.insertOne({ _id: saleId, storeId: s.storeId, saleNumber: 'POS-00001', total: 118, tax: 18, subtotal: 100, status: 'completed', paymentMethod: 'cash', payments: [{ method: 'cash', amount: 118 }], customerName: 'Carla Customer', customerId: 'cust-1', notes: 'phone 555-0111', employeeName: 'Cal Cashier', items: [{ name: 'Tea', qty: 1, price: 100 }] });
    await h.repos.posSettingsModel.collection.insertOne({ storeId: s.storeId, businessAddress: '1 Main', businessTaxId: 'TAX-9', receiptHeader: 'Hi', saleCounter: 1 });
    await svc().request(s.sellerId, 'pw-12345');
    expect(await svc().purgeDue(new Date(Date.now() + (DELETION_GRACE_DAYS + 1) * DAY))).toBe(1);

    const sel = await seller(s.sellerId);
    expect(sel).toMatchObject({ name: 'Deleted account', status: 'deleted', isDelete: true, phone: null, address: null, password: null, providerId: null, fcmToken: null, profileImage: null });
    expect(sel.email).toMatch(/^deleted\+.*@deleted\.invalid$/);
    expect(sel.anonymizedAt).toBeTruthy();

    const emp: any = await h.repos.employeeModel.collection.findOne({ _id: new Types.ObjectId(s.cashierId) });
    expect(emp).toMatchObject({ name: 'Deleted employee', pin: null, isDelete: true, phone: null });
    expect(emp.email).toMatch(/deleted\.invalid$/);

    const sale: any = await h.repos.saleModel.collection.findOne({ _id: saleId });
    expect(sale).toMatchObject({ customerName: 'Deleted customer', customerId: null, notes: null, employeeName: 'Deleted employee' });
    expect(sale).toMatchObject({ total: 118, tax: 18, subtotal: 100, saleNumber: 'POS-00001', status: 'completed' }); // the record the law requires
    expect(sale.items[0].name).toBe('Tea');

    const settings: any = await h.repos.posSettingsModel.collection.findOne({ storeId: s.storeId });
    expect(settings).toMatchObject({ businessAddress: null, businessTaxId: null, receiptHeader: null });
    expect(await h.repos.posDeviceModel.countDocuments({ storeId: s.storeId })).toBe(0);
    expect((await h.repos.storeModel.collection.findOne({ _id: new Types.ObjectId(s.storeId) }) as any).isDelete).toBe(true);
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'account_purged' })).toBe(1);
  });

  it('is idempotent and leaves other sellers alone', async () => {
    const a = await seedStore(h); await seedSeller(a);
    const b = await seedStore(h);
    await h.repos.sellerModel.collection.insertOne({ _id: new Types.ObjectId(b.sellerId), name: 'Bob', email: 'bob@x.com', role: 'seller', status: 'active', isDelete: false });
    await svc().request(a.sellerId, 'pw-12345');
    const later = new Date(Date.now() + 40 * DAY);
    await svc().purgeDue(later);
    expect(await svc().purgeDue(later)).toBe(0);
    expect((await seller(b.sellerId)).name).toBe('Bob');
  });
});
