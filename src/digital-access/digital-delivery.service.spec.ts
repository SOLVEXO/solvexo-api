import { DigitalAccessService } from './digital-access.service';
import { DigitalDeliveryService } from './digital-delivery.service';
import { DeliveryLog, DigitalAccess } from './digital-access.schema';
import { FakeModel, FakeRedis, digitalProduct, makeDb, paidOrder } from './testing/fake-db.kit-spec';

const ctx = (ip = '1.1.1.1') => ({ ip, userAgent: 'jest' });

function setup(storeOver: any = {}) {
  const k = makeDb();
  const redis = new FakeRedis();
  const accessModel = new FakeModel({ status: 'active', downloadCount: 0, audit: [] });
  const logModel = new FakeModel();
  k.orderModel.rows.push(paidOrder());
  k.productModel.rows.push(digitalProduct());
  k.storeModel.rows.push({ _id: 's1', ...storeOver });
  const upload: any = { resolveMimeType: () => 'application/pdf', generateSignedUrl: () => 'https://signed.example/file' };
  const memberships: any = { hasPlanAccess: async () => false };
  const mailer: any = { purchaseDelivered: jest.fn(), fileUpdated: jest.fn() };
  const access = new DigitalAccessService(k.db, accessModel as any, logModel as any, mailer);
  const delivery = new DigitalDeliveryService(k.db, redis as any, upload, access, memberships, mailer);
  (global as any).fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  return { ...k, redis, accessModel, logModel, access, delivery };
}
void DeliveryLog; void DigitalAccess;

describe('digital delivery tokens', () => {
  it('serves a file once and rejects a replay of the same token', async () => {
    const s = setup();
    const t = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    const file = await s.delivery.redeem(t.token, ctx());
    expect(file.buffer.length).toBe(4);
    await expect(s.delivery.redeem(t.token, ctx())).rejects.toThrow('expired or already used');
  });

  it('rejects an expired token (key gone from Redis)', async () => {
    const s = setup();
    const t = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    s.redis.kv.clear();
    await expect(s.delivery.redeem(t.token, ctx())).rejects.toThrow('expired or already used');
  });

  it('rejects garbage tokens', async () => {
    const s = setup();
    await expect(s.delivery.redeem('nope', ctx())).rejects.toThrow('expired or already used');
    await expect(s.delivery.redeem('x'.repeat(500), ctx())).rejects.toThrow('Invalid link');
  });

  it('wrong store and wrong customer get no token', async () => {
    const s = setup();
    await expect(s.delivery.mintToken('s2', 'c1', 'p1', 0, ctx())).rejects.toThrow();
    await expect(s.delivery.mintToken('s1', 'c2', 'p1', 0, ctx())).rejects.toThrow('do not have access');
    expect(s.logModel.rows.filter((l) => l.outcome === 'denied').length).toBe(2);
  });

  it('a token minted for one customer cannot be used after access is revoked', async () => {
    const s = setup();
    const t = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    s.orderModel.rows[0].sellerOrders[0].items[0].status = 'refunded';
    await expect(s.delivery.redeem(t.token, ctx())).rejects.toThrow('do not have access');
  });

  it('enforces the download limit and gives the count back when storage fails', async () => {
    const s = setup();
    s.productModel.rows[0].digital.downloadLimit = '1';
    const t = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    (global as any).fetch = async () => ({ ok: false });
    await expect(s.delivery.redeem(t.token, ctx())).rejects.toThrow('Failed to fetch');
    expect(s.accessModel.rows[0].downloadCount).toBe(0);
    (global as any).fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
    const t2 = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    await s.delivery.redeem(t2.token, ctx());
    await expect(s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx())).rejects.toThrow('limit reached');
  });

  it('two tokens cannot both consume the last download', async () => {
    const s = setup();
    s.productModel.rows[0].digital.downloadLimit = '1';
    const a = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    const b = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    await s.delivery.redeem(a.token, ctx());
    await expect(s.delivery.redeem(b.token, ctx())).rejects.toThrow('limit reached');
  });

  it('caps concurrent downloads per customer', async () => {
    const s = setup();
    s.redis.counters.set('dl:conc:c1', 3); // three downloads already running
    const t = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx());
    await expect(s.delivery.redeem(t.token, ctx())).rejects.toThrow('Too many downloads');
  });

  it('rate limits token minting per customer', async () => {
    const s = setup();
    s.redis.counters.set('dl:mint:c:c1', 30);
    await expect(s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx())).rejects.toThrow('Too many download requests');
  });

  it('refuses archived files and plan-locked files without a membership', async () => {
    const s = setup();
    s.productModel.rows[0].digital.files[0].archived = true;
    await expect(s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx())).rejects.toThrow('File not found');
    s.productModel.rows[0].digital.files[0].archived = false;
    s.productModel.rows[0].digital.files[0].requiresPlan = 'plan1';
    await expect(s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx())).rejects.toThrow('requires a membership');
  });

  it('a store paused by the platform serves nothing', async () => {
    const s = setup({ digitalDisabled: true });
    await expect(s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx())).rejects.toThrow('paused');
  });
});

describe('IP anomaly modes', () => {
  async function download(s: ReturnType<typeof setup>, ip: string) {
    const t = await s.delivery.mintToken('s1', 'c1', 'p1', 0, ctx(ip));
    return s.delivery.redeem(t.token, ctx(ip));
  }
  const manyIps = async (s: ReturnType<typeof setup>) => {
    s.productModel.rows[0].digital.downloadLimit = 'unlimited';
    for (let i = 1; i <= 5; i++) await download(s, `9.9.9.${i}`).catch(() => undefined);
  };

  it('soft-flag (default): flags the access but keeps serving', async () => {
    const s = setup();
    await manyIps(s);
    expect(s.accessModel.rows[0].flagged).toBe(true);
    expect(s.logModel.rows.filter((l) => l.outcome === 'ok').length).toBe(5);
  });

  it('off: never flags', async () => {
    const s = setup({ digitalAbuseMode: 'off' });
    await manyIps(s);
    expect(!!s.accessModel.rows[0].flagged).toBe(false);
  });

  it('block: the 5th distinct IP is refused', async () => {
    const s = setup({ digitalAbuseMode: 'block' });
    s.productModel.rows[0].digital.downloadLimit = 'unlimited';
    for (let i = 1; i <= 4; i++) await download(s, `8.8.8.${i}`);
    await expect(download(s, '8.8.8.5')).rejects.toThrow('paused for this account');
  });

  it('many downloads from ONE shared IP are never an anomaly', async () => {
    const s = setup({ digitalAbuseMode: 'block' });
    s.productModel.rows[0].digital.downloadLimit = 'unlimited';
    for (let i = 0; i < 8; i++) await download(s, '7.7.7.7');
    expect(!!s.accessModel.rows[0].flagged).toBe(false);
  });
});
