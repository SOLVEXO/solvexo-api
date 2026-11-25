/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosPermissionsStoreService } from './pos-permissions-store.service';
import { PosStoreSettingsService } from './pos-store-settings.service';
import { ROLE_PRESETS } from './pos-role-presets';
import { overrideErrors } from './pos-permissions.config';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G5.6 on a real replica-set MongoDB: the receipt logo (owner only, content-checked, audited) and role presets (owner only, preview, audited, version-guarded). */
jest.setTimeout(300_000);
let h: MongoHarness; let r: any; let perms: PosPermissionsStoreService; let st: PosStoreSettingsService;
const uploads: any[] = [];
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness(); r = h.repos;
  const dbs: any = { repositories: r };
  const pos = new PosService(dbs, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, pos);
  perms = new PosPermissionsStoreService(dbs, pos, auth);
  st = new PosStoreSettingsService(dbs, pos, auth, { uploadFile: async (f: any, o: any) => { uploads.push({ f, o }); return { url: `https://res.example/${o.folder}/logo-${uploads.length}.png` }; } } as any);
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed) => jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const file = (buffer: Buffer, size = buffer.length) => ({ buffer, size, originalname: 'logo.png', mimetype: 'application/octet-stream' }) as any;

describe('G5.6 · receipt logo', () => {
  it('owner uploads (checked by content, resized to ≤ 1024 px), the till reads logoUrl, owner removes it; both audited; a manager is refused', async () => {
    const s = await seedStore(h);
    expect((await st.get(owner(s), s.storeId, {})).data.receipt.logoUrl).toBeNull();
    expect(await code(st.uploadReceiptLogo(device(s), s.storeId, file(PNG), { employee: tok(s) }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(st.uploadReceiptLogo(owner(s), s.storeId, file(Buffer.from('GIF89a........')), {}))).toBe('FILE_TYPE');
    expect(await code(st.uploadReceiptLogo(owner(s), s.storeId, file(PNG, 3 * 1024 * 1024), {}))).toBe('FILE_TOO_LARGE');
    expect(await code(st.uploadReceiptLogo(owner(s), s.storeId, undefined, {}))).toBe('FILE_REQUIRED');
    const up: any = (await st.uploadReceiptLogo(owner(s), s.storeId, file(PNG), {})).data;
    expect(up.receipt.logoUrl).toMatch(new RegExp(`receipt-logos/${s.storeId}/`));
    expect(uploads.at(-1).o.maxDimension).toBe(1024);
    expect(uploads.at(-1).f.mimetype).toBe('image/png');
    const ps: any = await r.posSettingsModel.findOne({ storeId: s.storeId }).lean();
    expect(ps.receiptLogoUrl).toBe(up.receipt.logoUrl); // the till's settings carry it
    expect(await code(st.update(owner(s), s.storeId, { receipt: { logoUrl: 'https://evil/x.png' } }, {}))).toBe('NOTHING_TO_CHANGE'); // read-only via settings
    await st.removeReceiptLogo(owner(s), s.storeId, {});
    expect((await st.get(owner(s), s.storeId, {})).data.receipt.logoUrl).toBeNull();
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: { $in: ['receipt_logo_changed', 'receipt_logo_removed'] } })).toBe(2);
  });
});

describe('G5.6 · role presets (proposed)', () => {
  it('every preset fits the matrix (owner never removed, nothing pinned touched)', () => {
    for (const p of ROLE_PRESETS) expect([p.key, overrideErrors(p.overrides)]).toEqual([p.key, []]);
    expect(ROLE_PRESETS.map((p) => p.key)).toEqual(['standard', 'small_shop', 'strict']);
  });

  it('listed as proposed; owner previews (nothing saved), applies (replaces overrides, audited with the diff, version bumps); a manager cannot; stale version → conflict', async () => {
    const s = await seedStore(h);
    const got: any = (await perms.get(owner(s), s.storeId, {})).data;
    expect(got.presets.map((p: any) => [p.key, p.status])).toEqual([['standard', 'proposed'], ['small_shop', 'proposed'], ['strict', 'proposed']]);
    expect(await code(perms.applyPreset(device(s), s.storeId, { preset: 'strict' }, { employee: tok(s) }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(perms.applyPreset(owner(s), s.storeId, { preset: 'nope' }, {}))).toBe('PRESET_UNKNOWN');
    const prev: any = (await perms.applyPreset(owner(s), s.storeId, { preset: 'strict', preview: true }, {})).data;
    expect(prev.diff.map((d: any) => d.action)).toEqual(expect.arrayContaining(['inventory.adjust', 'catalog.import', 'storeCredit.adjust']));
    expect((await perms.get(owner(s), s.storeId, {})).data.version).toBe(0);
    await perms.update(owner(s), s.storeId, { changes: { 'customers.create': { roles: ['manager', 'owner'] } } }, {}); // something the preset does not mention
    const done: any = (await perms.applyPreset(owner(s), s.storeId, { preset: 'strict', expectedVersion: 1 }, {})).data;
    expect(done.version).toBe(2);
    const row = (a: string) => done.actions.find((x: any) => x.action === a);
    expect(row('inventory.adjust').roles).toEqual(['manager', 'owner']);
    expect(row('customers.create').roles).toEqual(['cashier', 'manager', 'owner']); // replaced, not merged
    const log: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'permissions_preset_applied' }).lean();
    expect([log.metadata.preset, log.metadata.version, log.metadata.diff.length > 0]).toEqual(['strict', 2, true]);
    expect(await code(perms.applyPreset(owner(s), s.storeId, { preset: 'small_shop', expectedVersion: 1 }, {}))).toBe('VERSION_CONFLICT');
    const std: any = (await perms.applyPreset(owner(s), s.storeId, { preset: 'standard' }, {})).data; // back to the defaults
    expect(std.actions.every((a: any) => !a.changed)).toBe(true);
  });
});
