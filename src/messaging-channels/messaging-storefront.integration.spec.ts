/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for the customer's own messaging preferences (storefront). Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit messaging-storefront.integration
 */
import mongoose, { Connection, Types } from 'mongoose';
import { MessagingStorefrontController } from './messaging-storefront.controller';
import { MessagingConsentService } from './messaging-consent.service';
import { MessagingConsentSchema } from './messaging.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());

d('Storefront messaging preferences on a real MongoDB', () => {
  let conn: Connection;
  let m: any;
  let ctl: MessagingStorefrontController;
  let consent: MessagingConsentService;
  const sms = { activeConfig: jest.fn() };
  const STORE = oid();
  const OTHER = oid();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `msgsf_it_${Date.now()}` }).asPromise();
    m = {
      consents: conn.model('MessagingConsent', MessagingConsentSchema), users: conn.model('User', new mongoose.Schema({}, { strict: false })),
      integrations: conn.model('StoreIntegration', new mongoose.Schema({}, { strict: false })),
    };
    await m.consents.init();
    await m.integrations.collection.insertOne({ storeId: STORE, type: 'whatsapp', provider: 'whatsapp_cloud', status: 'connected' });
    consent = new MessagingConsentService(m.consents);
    ctl = new MessagingStorefrontController(consent, sms as any, { repositories: { storeIntegrationModel: m.integrations, userModel: m.users } } as any, m.consents);
  });
  afterAll(async () => { delete process.env.MESSAGING_CAMPAIGNS_ENABLED; await conn.dropDatabase(); await conn.close(); });
  beforeEach(() => { process.env.MESSAGING_CAMPAIGNS_ENABLED = 'true'; sms.activeConfig.mockReset().mockResolvedValue(null); });

  const customer = async (storeId = STORE, extra: any = {}) => {
    const id = oid();
    await m.users.collection.insertOne({ _id: new Types.ObjectId(id), storeId, email: id + '@x.com', ...extra });
    return { user: { userId: id, storeId } } as any;
  };

  it('offers only the channels the store really has, and nothing while the feature is off', async () => {
    const req = await customer();
    expect(((await ctl.me(req)) as any).available).toEqual({ whatsapp: true, sms: false });
    sms.activeConfig.mockResolvedValue({ dailyLimit: 5 });
    expect(((await ctl.me(req)) as any).available).toEqual({ whatsapp: true, sms: true });
    process.env.MESSAGING_CAMPAIGNS_ENABLED = 'false';
    expect(((await ctl.me(req)) as any).available).toEqual({ whatsapp: false, sms: false });
    await expect(ctl.optIn(req, { channel: 'whatsapp', phone: '0300-1234567', agreed: true })).rejects.toThrow(/does not send messages/);
  });

  it('opt-in needs the ticked box, a valid phone, a real account and an offered channel; it is tied to this customer and store', async () => {
    const req = await customer();
    await expect(ctl.optIn(req, { channel: 'whatsapp', phone: '0300-1234567', agreed: false })).rejects.toThrow(/Tick the box/);
    await expect(ctl.optIn(req, { channel: 'telegram', phone: '0300-1234567', agreed: true })).rejects.toThrow(/channel/);
    await expect(ctl.optIn(req, { channel: 'sms', phone: '0300-1234567', agreed: true })).rejects.toThrow(/does not send messages/);
    await expect(ctl.optIn(req, { channel: 'whatsapp', phone: 'abc', agreed: true })).rejects.toThrow(/valid phone/);
    const guest = await customer(STORE, { isGuest: true });
    await expect(ctl.optIn(guest, { channel: 'whatsapp', phone: '0300-1234567', agreed: true })).rejects.toThrow(/Sign in/);

    const res: any = await ctl.optIn(req, { channel: 'whatsapp', phone: '0300-1234567', agreed: true });
    expect(res.consents).toEqual([expect.objectContaining({ channel: 'whatsapp', status: 'opted_in', phoneEnding: '4567' })]);
    const row: any = await m.consents.findOne({ storeId: STORE, contactKey: '923001234567' }).lean();
    expect(row).toMatchObject({ optInSource: 'storefront', customerId: req.user.userId });
    expect(await m.consents.countDocuments({ storeId: OTHER })).toBe(0);
  });

  it('the customer can opt out without typing the number again, and only sees their own consent', async () => {
    const a = await customer(); const b = await customer();
    await ctl.optIn(a, { channel: 'whatsapp', phone: '0301-1111111', agreed: true });
    await ctl.optIn(b, { channel: 'whatsapp', phone: '0302-2222222', agreed: true });
    expect(((await ctl.me(a)) as any).consents).toHaveLength(1);
    const after: any = await ctl.optOut(a, { channel: 'whatsapp' });
    expect(after.consents[0]).toMatchObject({ status: 'opted_out', phoneEnding: '1111' });
    expect((await consent.statusFor(STORE, 'whatsapp', ['923021111111', '923022222222'])).get('923022222222')).toBe('opted_in');
    expect(((await ctl.me(b)) as any).consents[0].status).toBe('opted_in');
  });
});
