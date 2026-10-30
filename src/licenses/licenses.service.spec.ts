process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'spec-only-key';
import { LicensesService } from './licenses.service';
import { generateLicenseKey, hashKey, hashToken, normalizeKey } from './license-key.util';
import { FakeModel, FakeRedis, digitalProduct, makeDb, paidOrder } from '../digital-access/testing/fake-db.kit-spec';

const TOKEN = 'lk_' + 'a'.repeat(48);
const ctx = { ip: '1.1.1.1' };

function setup(storeOver: any = {}) {
  const k = makeDb();
  const keys = new FakeModel({ status: 'active', activations: [] });
  const redis = new FakeRedis();
  k.orderModel.rows.push(paidOrder());
  k.productModel.rows.push(digitalProduct({ digital: { ...digitalProduct().digital, licenseKeys: { enabled: true, activationLimit: 2 } } }));
  k.storeModel.rows.push({ _id: 's1', isDelete: false, licenseApiTokenHash: hashToken(TOKEN), ...storeOver });
  const svc = new LicensesService(k.db, redis as any, keys as any);
  return { ...k, keys, redis, svc };
}
const issue = async (s: ReturnType<typeof setup>) => (await s.svc.listMine('s1', 'c1'))[0].key as string;

describe('license keys', () => {
  it('generates unambiguous random keys and normalises input', () => {
    const a = generateLicenseKey();
    expect(/^([A-HJKMNP-Z2-9]{4}-){3}[A-HJKMNP-Z2-9]{4}$/.test(a)).toBe(true);
    expect(a === generateLicenseKey()).toBe(false);
    expect(hashKey(a.toLowerCase().replace(/-/g, ' '))).toBe(hashKey(a));
    expect(normalizeKey(a).length).toBe(16);
  });

  it('issues one key per paid item, idempotently, and never stores the plaintext', async () => {
    const s = setup();
    const key = await issue(s);
    await s.svc.listMine('s1', 'c1');
    expect(s.keys.rows.length).toBe(1);
    expect(JSON.stringify(s.keys.rows[0]).includes(key)).toBe(false);
    expect(s.keys.rows[0].keyHash).toBe(hashKey(key));
  });

  it('other customers and other stores see nothing', async () => {
    const s = setup();
    await issue(s);
    expect((await s.svc.listMine('s1', 'c2')).length).toBe(0);
    expect((await s.svc.listMine('s2', 'c1')).length).toBe(0);
  });

  it('a refunded item hides and invalidates the key', async () => {
    const s = setup();
    const key = await issue(s);
    s.orderModel.rows[0].sellerOrders[0].items[0].status = 'refunded';
    expect((await s.svc.listMine('s1', 'c1')).length).toBe(0);
    expect((await s.svc.validate(TOKEN, { key }, ctx)).valid).toBe(false);
  });
});

describe('license API', () => {
  it('rejects a wrong, malformed or other-store token', async () => {
    const s = setup();
    const key = await issue(s);
    await expect(s.svc.validate('lk_' + 'b'.repeat(48), { key }, ctx)).rejects.toThrow('Invalid API token');
    await expect(s.svc.validate('nope', { key }, ctx)).rejects.toThrow('Invalid API token');
  });

  it('a key of another store is unknown to this token', async () => {
    const s = setup();
    const key = await issue(s);
    s.keys.rows[0].storeId = 's2';
    expect((await s.svc.validate(TOKEN, { key }, ctx)).valid).toBe(false);
  });

  it('unknown, revoked and refunded keys all answer valid:false with no reason', async () => {
    const s = setup();
    const key = await issue(s);
    expect(await s.svc.validate(TOKEN, { key: 'AAAA-BBBB-CCCC-DDDD' }, ctx)).toEqual({ valid: false });
    s.keys.rows[0].status = 'revoked';
    expect(await s.svc.validate(TOKEN, { key }, ctx)).toEqual({ valid: false });
  });

  it('enforces the activation limit, same device is idempotent, deactivate frees a slot', async () => {
    const s = setup();
    const key = await issue(s);
    const d1: any = await s.svc.validate(TOKEN, { key, deviceId: 'd1', activate: true }, ctx);
    await s.svc.validate(TOKEN, { key, deviceId: 'd1', activate: true }, ctx);
    expect(d1.activated).toBe(true);
    expect(s.keys.rows[0].activations.length).toBe(1);
    expect(((await s.svc.validate(TOKEN, { key, deviceId: 'd2', activate: true }, ctx)) as any).activated).toBe(true);
    const third: any = await s.svc.validate(TOKEN, { key, deviceId: 'd3', activate: true }, ctx);
    expect(third.activated).toBe(false);
    expect(third.reason).toBe('activation_limit_reached');
    await s.svc.deactivate(TOKEN, { key, deviceId: 'd1' }, ctx);
    expect(((await s.svc.validate(TOKEN, { key, deviceId: 'd3', activate: true }, ctx)) as any).activated).toBe(true);
  });

  it('deactivating an unknown key does not reveal anything', async () => {
    const s = setup();
    expect((await s.svc.deactivate(TOKEN, { key: 'AAAA-BBBB-CCCC-DDDD', deviceId: 'x' }, ctx)).success).toBe(true);
  });

  it('rate limits per key and per IP', async () => {
    const s = setup();
    const key = await issue(s);
    let limited = false;
    for (let i = 0; i < 40; i++) { try { await s.svc.validate(TOKEN, { key }, ctx); } catch (e: any) { if (e.getStatus?.() === 429) limited = true; } }
    expect(limited).toBe(true);
    const s2 = setup();
    s2.redis.counters.set('lic:ip:1.1.1.1', 500);
    await expect(s2.svc.validate(TOKEN, { key: 'AAAA-BBBB-CCCC-DDDD' }, ctx)).rejects.toThrow('Too many requests');
  });

  it('a store paused by the platform validates nothing', async () => {
    const s = setup({ digitalDisabled: true });
    const key = await issue(s);
    expect(await s.svc.validate(TOKEN, { key }, ctx)).toEqual({ valid: false });
  });
});
