/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { ALERT_DEFAULTS, PosStoreSettingsService, RECEIPT_DEFAULTS } from './pos-store-settings.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { moneyContractViolations } from './testing/money-contract';

/** G4.4: settings hub — receipt designer, in-app alerts, security, sync status (owner edits, managers read, audited). */
jest.setTimeout(300_000);
let h: MongoHarness; let st: PosStoreSettingsService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, { posAuditSealModel: h.conn.model(schema.PosAuditSeal.name, schema.PosAuditSealSchema) });
  r = h.repos;
  const dbs: any = { repositories: r };
  const pos = new PosService(dbs, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  st = new PosStoreSettingsService(dbs, pos, new PosAuthorizer(dbs, pos));
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

it('defaults = today\'s behaviour; a manager reads (cannot edit); a cashier cannot read; the owner edits (audited before / after)', async () => {
  const s = await seedStore(h);
  const M = { employee: tok(s, 'manager') };
  const g = (await st.get(device(s), s.storeId, M)).data;
  expect(moneyContractViolations(g)).toEqual([]);
  expect(g.receipt).toMatchObject({ ...RECEIPT_DEFAULTS, header: null, footer: null });
  expect(g.alerts).toEqual(ALERT_DEFAULTS);
  expect([g.security.autoLockMinutes, g.canEdit]).toEqual([5, false]);
  expect(await code(st.get(device(s), s.storeId, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
  expect(await code(st.update(device(s), s.storeId, { alerts: { lowStock: false } }, M))).toBe('POS_ACTION_FORBIDDEN');
  const u = (await st.update(owner(s), s.storeId, { receipt: { showQr: false, defaultPaperWidth: 58, footer: 'Thank you!', promoText: '10% off Fridays' }, alerts: { lowStock: false }, security: { autoLockMinutes: 2, lockOnBackground: true } }, {})).data;
  expect([u.receipt.showQr, u.receipt.defaultPaperWidth, u.receipt.footer, u.receipt.promoText, u.alerts.lowStock, u.security.autoLockMinutes, u.security.lockOnBackground]).toEqual([false, 58, 'Thank you!', '10% off Fridays', false, 2, true]);
  expect((await r.posSettingsModel.findOne({ storeId: s.storeId }).lean()).autoLockMinutes).toBe(2); // the same field the till already uses
  const audit: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'store_settings_changed' }).lean();
  expect(audit.metadata.before['receiptOptions.showQr']).toBe(true);
  expect(audit.metadata.after['receiptOptions.showQr']).toBe(false);
  expect(audit.metadata.after['autoLockMinutes']).toBe(2);
});

it('refuses unknown keys, wrong types and out-of-range values — nothing is half-saved', async () => {
  const s = await seedStore(h);
  for (const [body, msg] of [[{ receipt: { showSecrets: true } }, /not a setting/], [{ alerts: { lowStock: 'yes' } }, /true or false/], [{ receipt: { defaultPaperWidth: 72 } }, /58 or 80/], [{ security: { autoLockMinutes: 0 } }, /1–240/], [{}, /Nothing/]] as const) {
    const e = await st.update(owner(s), s.storeId, body, {}).then(() => null, (x) => x?.response?.message);
    expect(e).toMatch(msg as RegExp);
  }
  expect(await code(st.update(owner(s), s.storeId, { alerts: { lowStock: false }, receipt: { nope: 1 } }, {}))).toBe('INVALID_SETTINGS');
  expect((await st.get(owner(s), s.storeId, {})).data.alerts.lowStock).toBe(true); // the valid half was NOT saved
});

it('sync status: server time, store zone, devices with last seen, the latest audit seal', async () => {
  const s = await seedStore(h);
  await r.posDeviceModel.collection.insertMany([{ storeId: s.storeId, name: 'Front till', platform: 'ios', lastSeenAt: new Date(), revokedAt: null }, { storeId: s.storeId, name: 'Old', revokedAt: new Date() }]);
  await r.posAuditSealModel.create({ storeId: s.storeId, day: '2026-11-01', timeZone: 'UTC', from: new Date('2026-11-01'), to: new Date('2026-11-02'), algorithm: 'sha256-v1', parts: {}, count: 4, prevHash: null, hash: 'h' });
  const d = (await st.syncStatus(device(s), s.storeId, { employee: tok(s, 'manager') })).data;
  expect(moneyContractViolations(d)).toEqual([]);
  expect(d.devices.map((x: any) => x.name)).toEqual(['Front till']);
  expect(d.lastSeal).toMatchObject({ day: '2026-11-01', records: 4 });
  expect(d.timeZone).toBe('UTC');
});
