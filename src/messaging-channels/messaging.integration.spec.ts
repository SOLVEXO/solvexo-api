/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for WhatsApp marketing: consent, templates, throttled campaigns, delivery reports and STOP.
 * The WhatsApp provider is a fake (no network). Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit messaging.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { MessagingConsentService } from './messaging-consent.service';
import { MessagingCampaignsService } from './messaging-campaigns.service';
import { MessagingWebhookService } from './messaging-webhook.service';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { WhatsAppCloudProvider } from '../integrations/providers/whatsapp-cloud.provider';
import { MessagingCampaignSchema, MessagingConsentSchema, MessagingMessageSchema, WhatsAppTemplateSchema } from './messaging.schema';
import { encryptCredential } from '../common/credential-encryption.util';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());
const actor = { id: 'seller-1', role: 'seller' };

d('WhatsApp marketing on a real MongoDB', () => {
  let conn: Connection;
  let m: any;
  let consent: MessagingConsentService;
  let camp: MessagingCampaignsService;
  let hook: MessagingWebhookService;
  let tpl: WhatsAppTemplatesService;
  let db: any;
  const queued: string[][] = [];
  const provider = { sendTemplateMessage: jest.fn(), listTemplates: jest.fn(), createTemplate: jest.fn(), deleteTemplate: jest.fn() };
  const segments = { loadFilter: jest.fn(), resolveContacts: jest.fn() };
  const STORE = oid();
  const OTHER = oid();
  const PHONE_ID = 'pn-1';
  const phone = (n: number) => `0300${String(1000000 + n)}`;
  const keyOf = (n: number) => `92300${String(1000000 + n)}`;

  beforeAll(async () => {
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `msg_it_${Date.now()}` }).asPromise();
    m = {
      consents: conn.model('MessagingConsent', MessagingConsentSchema), templates: conn.model('WhatsAppTemplate', WhatsAppTemplateSchema),
      campaigns: conn.model('MessagingCampaign', MessagingCampaignSchema), messages: conn.model('MessagingMessage', MessagingMessageSchema),
      integrations: conn.model('StoreIntegration', new mongoose.Schema({}, { strict: false })), stores: conn.model('Store', new mongoose.Schema({}, { strict: false })),
    };
    await Promise.all([m.consents.init(), m.templates.init(), m.campaigns.init(), m.messages.init()]);
    await m.stores.collection.insertMany([{ _id: new Types.ObjectId(STORE), name: 'Shop A' }, { _id: new Types.ObjectId(OTHER), name: 'Shop B' }]);
    await m.integrations.collection.insertOne({ storeId: STORE, type: 'whatsapp', provider: 'whatsapp_cloud', status: 'connected', credentialsEncrypted: encryptCredential(JSON.stringify({ accessToken: 'tok' }), 'INTEGRATIONS'), config: { phoneNumberId: PHONE_ID, wabaId: 'waba-1' } });
    db = { repositories: { storeModel: m.stores, storeIntegrationModel: m.integrations } };
    const moduleRef: any = { get: () => provider };
    const activity = { log: jest.fn().mockResolvedValue(undefined) } as any;
    consent = new MessagingConsentService(m.consents);
    tpl = new WhatsAppTemplatesService(m.templates, db, moduleRef);
    camp = new MessagingCampaignsService(m.campaigns, m.messages, m.consents, m.templates, { add: jest.fn(async (_n: string, data: { ids: string[] }) => { queued.push(data.ids); }) } as any, db, activity, {} as any, consent, tpl, segments as any, moduleRef);
    hook = new MessagingWebhookService(m.messages, db, consent);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });
  beforeEach(() => { provider.sendTemplateMessage.mockReset(); provider.listTemplates.mockReset(); provider.createTemplate.mockReset(); segments.loadFilter.mockReset(); segments.resolveContacts.mockReset(); queued.length = 0; });

  const approvedTemplate = async (over: any = {}) => m.templates.create({ storeId: STORE, name: 't' + oid().slice(-6), language: 'en_US', category: 'MARKETING', status: 'APPROVED', bodyText: 'Hi {{1}}, sale at {{2}}', paramCount: 2, ...over });
  const optIns = async (n: number, storeId = STORE) => { for (let i = 0; i < n; i++) await consent.optIn(storeId, 'whatsapp', phone(i), { source: 'manual', name: 'C' + i }); };
  const newCampaign = async (over: any = {}) => {
    const t: any = await approvedTemplate();
    return (await camp.create(STORE, actor, { name: 'Eid', templateId: String(t._id), params: ['{customer_name}', '{store_name}'], ...over })) as any;
  };
  const sendAll = async () => { for (const ids of queued.splice(0)) await camp.sendBatch(ids); };
  const wipe = async () => { await m.consents.deleteMany({}); await m.messages.deleteMany({}); await m.campaigns.deleteMany({}); };

  describe('consent', () => {
    beforeEach(wipe);
    it('opt-in is per store and per channel; invalid phones are refused; sources are validated', async () => {
      await consent.optIn(STORE, 'whatsapp', '0300-1234567', { source: 'storefront' });
      expect((await consent.statusFor(STORE, 'whatsapp', ['923001234567'])).get('923001234567')).toBe('opted_in');
      expect((await consent.statusFor(OTHER, 'whatsapp', ['923001234567'])).size).toBe(0);
      expect((await consent.statusFor(STORE, 'sms', ['923001234567'])).size).toBe(0);
      await expect(consent.optIn(STORE, 'whatsapp', 'abc', { source: 'manual' })).rejects.toThrow(/valid phone/);
      await expect(consent.optIn(STORE, 'whatsapp', '0300-1234567', { source: 'hacked' })).rejects.toThrow(/source/);
      await expect(consent.optIn(STORE, 'telegram' as any, '0300-1234567', { source: 'manual' })).rejects.toThrow(/channel/);
    });
    it('opt-out is immediate, works for strangers, keeps history, and a fresh explicit opt-in is allowed', async () => {
      await consent.optIn(STORE, 'whatsapp', '0300-1234567', { source: 'manual' });
      await consent.optOut(STORE, 'whatsapp', '+92 300 1234567', 'inbound_stop');
      let row: any = await m.consents.findOne({ storeId: STORE, contactKey: '923001234567' }).lean();
      expect(row).toMatchObject({ status: 'opted_out', optOutSource: 'inbound_stop' });
      expect(row.history.map((h: any) => h.status)).toEqual(['opted_in', 'opted_out']);
      await consent.optOut(STORE, 'whatsapp', '0311-9999999', 'seller');
      expect((await consent.statusFor(STORE, 'whatsapp', ['923119999999'])).get('923119999999')).toBe('opted_out');
      await consent.optIn(STORE, 'whatsapp', '0300-1234567', { source: 'storefront' });
      row = await m.consents.findOne({ storeId: STORE, contactKey: '923001234567' }).lean();
      expect(row.status).toBe('opted_in');
    });
    it('import needs the seller attestation, counts invalid rows and NEVER re-subscribes a STOP', async () => {
      await consent.optOut(STORE, 'whatsapp', '0300-0000001', 'inbound_stop');
      await expect(consent.importOptIns(STORE, 'whatsapp', [{ phone: '0300-1111111' }], false)).rejects.toThrow(/agreed/);
      await expect(consent.importOptIns(STORE, 'whatsapp', [], true)).rejects.toThrow(/between 1 and 5000/);
      const r = await consent.importOptIns(STORE, 'whatsapp', [{ phone: '0300-1111111', name: 'A' }, { phone: 'bad' }, { phone: '0300-0000001' }], true);
      expect(r).toEqual({ added: 1, invalid: 1, keptOptedOut: 1 });
      expect((await consent.statusFor(STORE, 'whatsapp', ['923000000001'])).get('923000000001')).toBe('opted_out');
      expect(((await m.consents.findOne({ contactKey: '923001111111' }).lean()) as any).optInSource).toBe('import');
    });
    it('list is store-scoped with counts', async () => {
      await optIns(3); await consent.optOut(STORE, 'whatsapp', phone(0), 'seller'); await consent.optIn(OTHER, 'whatsapp', phone(9), { source: 'manual' });
      const l: any = await consent.list(STORE, {});
      expect(l).toMatchObject({ total: 3, optedIn: 2, optedOut: 1 });
      expect((await consent.list(STORE, { status: 'opted_out' })).total).toBe(1);
    });
  });

  describe('templates', () => {
    it('submit validates, always sends category MARKETING, stores PENDING; duplicates refused; needs a connected account', async () => {
      provider.createTemplate.mockResolvedValue({ ok: true, id: 'meta-1', status: 'PENDING' });
      await expect(tpl.submit(STORE, { name: 'Bad Name', language: 'en_US', bodyText: 'x', examples: [] })).rejects.toThrow(/lowercase/);
      const t: any = await tpl.submit(STORE, { name: 'eid_offer', language: 'en_US', bodyText: 'Hi {{1}}, eid offer!', examples: ['Ali'] });
      expect(t).toMatchObject({ status: 'PENDING', category: 'MARKETING', paramCount: 1, metaId: 'meta-1' });
      expect(provider.createTemplate.mock.calls[0][2]).toMatchObject({ category: 'MARKETING', name: 'eid_offer' });
      await expect(tpl.submit(STORE, { name: 'eid_offer', language: 'en_US', bodyText: 'Hi {{1}}', examples: ['A'] })).rejects.toThrow(/already exists/);
      provider.createTemplate.mockResolvedValue({ ok: false, error: 'Invalid parameter' });
      await expect(tpl.submit(STORE, { name: 'other_one', language: 'en_US', bodyText: 'Hi', examples: [] })).rejects.toThrow(/did not accept/);
      await expect(tpl.submit(OTHER, { name: 'x_y', language: 'en_US', bodyText: 'Hi', examples: [] })).rejects.toThrow(/Connect your WhatsApp/);
    });
    it('sync records status and rejection reason from Meta, store-scoped', async () => {
      provider.listTemplates.mockResolvedValue({ ok: true, templates: [{ id: 'm9', name: 'eid_offer', language: 'en_US', status: 'approved', category: 'marketing', rejectedReason: null, bodyText: 'Hi {{1}}, eid offer!' }, { id: 'm8', name: 'bad_one', language: 'en_US', status: 'REJECTED', category: 'MARKETING', rejectedReason: 'INVALID_FORMAT', bodyText: 'x' }] });
      expect(await tpl.sync(STORE)).toEqual({ synced: 2 });
      const rows: any[] = await tpl.list(STORE);
      expect(rows.find((r) => r.name === 'eid_offer')).toMatchObject({ status: 'APPROVED', category: 'MARKETING', paramCount: 1 });
      expect(rows.find((r) => r.name === 'bad_one')).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' });
      expect((await tpl.list(OTHER)).length).toBe(0);
      provider.listTemplates.mockResolvedValue({ ok: false, error: 'token expired' });
      await expect(tpl.sync(STORE)).rejects.toThrow(/token expired/);
    });
  });

  describe('campaigns', () => {
    beforeEach(wipe);

    it('create checks the template belongs to the store, the number of placeholders and the segment', async () => {
      const t: any = await approvedTemplate();
      await expect(camp.create(STORE, actor, { name: 'X', templateId: String(t._id), params: ['only one'] })).rejects.toThrow(/2 placeholder/);
      await expect(camp.create(OTHER, actor, { name: 'X', templateId: String(t._id), params: ['a', 'b'] })).rejects.toThrow(/Template not found/);
      segments.loadFilter.mockResolvedValue(null);
      await expect(camp.create(STORE, actor, { name: 'X', templateId: String(t._id), params: ['a', 'b'], segmentId: oid() })).rejects.toThrow(/Segment not found/);
      await expect(camp.create(STORE, actor, { name: ' ', templateId: String(t._id), params: ['a', 'b'] })).rejects.toThrow(/name is required/);
    });

    it('only an approved template can launch; only opted-in contacts get a message; launching twice sends once', async () => {
      await optIns(3); await consent.optOut(STORE, 'whatsapp', phone(1), 'seller');
      const pending: any = await approvedTemplate({ status: 'PENDING' });
      const c1 = (await camp.create(STORE, actor, { name: 'P', templateId: String(pending._id), params: ['a', 'b'] })) as any;
      await expect(camp.launch(STORE, actor, String(c1._id))).rejects.toThrow(/approved/);
      expect(((await m.campaigns.findById(c1._id).lean()) as any).status).toBe('draft');

      const c = await newCampaign();
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'wamid' });
      const res = await Promise.allSettled([camp.launch(STORE, actor, String(c._id)), camp.launch(STORE, actor, String(c._id))]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await sendAll();
      const msgs: any[] = await m.messages.find({ campaignId: String(c._id) }).lean();
      expect(msgs.map((x) => x.contactKey).sort()).toEqual([keyOf(0), keyOf(2)]);
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(2);
      expect(provider.sendTemplateMessage.mock.calls[0][0]).toMatchObject({ accessToken: 'tok', phoneNumberId: PHONE_ID });
      expect(provider.sendTemplateMessage.mock.calls.map((c: any) => c[2].bodyParams[0]).sort()).toEqual(['C0', 'C2']);
      expect(provider.sendTemplateMessage.mock.calls[0][2].bodyParams[1]).toBe('Shop A');
      expect(((await m.campaigns.findById(c._id).lean()) as any).status).toBe('completed');
    });

    it('a launch with nobody opted in is refused and the campaign stays a draft', async () => {
      const c = await newCampaign();
      await expect(camp.launch(STORE, actor, String(c._id))).rejects.toThrow(/No opted-in contacts/);
      expect(((await m.campaigns.findById(c._id).lean()) as any).status).toBe('draft');
    });

    it('a segment narrows the audience; members without consent or who opted out are recorded as skipped, never messaged', async () => {
      await optIns(2); await consent.optOut(STORE, 'whatsapp', phone(2), 'seller');
      segments.loadFilter.mockResolvedValue({ combinator: 'all', conditions: [] });
      segments.resolveContacts.mockResolvedValue([
        { customerId: 'c0', name: 'Zero', phone: phone(0) }, { customerId: 'c1', name: 'One', phone: phone(1) },
        { customerId: 'c2', name: 'Two', phone: phone(2) }, { customerId: 'c3', name: 'Three', phone: phone(3) }, { customerId: 'dup', name: 'Dup', phone: '+92 300 1000000' },
      ]);
      const c = await newCampaign({ segmentId: oid() });
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      const stats: any = await camp.launch(STORE, actor, String(c._id));
      await sendAll();
      const by = Object.fromEntries((await m.messages.find({ campaignId: String(c._id) }).lean()).map((x: any) => [x.contactKey, x.status]));
      expect(by).toMatchObject({ [keyOf(0)]: 'sent', [keyOf(1)]: 'sent', [keyOf(2)]: 'skipped_opted_out', [keyOf(3)]: 'skipped_no_consent' });
      expect(Object.keys(by)).toHaveLength(4); // the duplicate phone is one contact
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(2);
      expect(stats.skipped).toBe(2);
    });

    it('throttling: only the daily limit of unique contacts is sent now, the rest waits and goes out after 24 hours', async () => {
      await optIns(5);
      const c = await newCampaign({ dailyLimit: 3 });
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      await camp.launch(STORE, actor, String(c._id));
      await sendAll();
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(3);
      expect(await m.messages.countDocuments({ campaignId: String(c._id), status: 'queued' })).toBe(2);
      expect(((await m.campaigns.findById(c._id).lean()) as any).status).toBe('sending');

      expect(await camp.dispatch(String(c._id))).toBe(0); // still today: no room
      await m.messages.updateMany({ status: 'sent' }, { $set: { sentAt: new Date(Date.now() - 25 * 3600_000) } });
      expect(await camp.dispatch(String(c._id))).toBe(1);
      await sendAll();
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(5);
      expect(((await m.campaigns.findById(c._id).lean()) as any).status).toBe('completed');
    });

    it('the limit counts unique contacts across ALL campaigns of the store, not per campaign', async () => {
      await optIns(4);
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      const a = await newCampaign({ dailyLimit: 3 });
      await camp.launch(STORE, actor, String(a._id)); await sendAll();
      const b = await newCampaign({ dailyLimit: 3 });
      await camp.launch(STORE, actor, String(b._id)); await sendAll();
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(3); // campaign B found no room left today
      expect(await m.messages.countDocuments({ campaignId: String(b._id), status: 'queued' })).toBe(4);
    });

    it('consent withdrawn after the batch was claimed but before the send wins: nothing is sent to that contact', async () => {
      await optIns(2);
      const c = await newCampaign();
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      await camp.launch(STORE, actor, String(c._id));
      await consent.optOut(STORE, 'whatsapp', phone(0), 'inbound_stop'); // STOP arrives while the job waits in the queue
      await sendAll();
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(1);
      expect(((await m.messages.findOne({ contactKey: keyOf(0) }).lean()) as any).status).toBe('skipped_opted_out');
    });

    it('sending the same batch twice (job redelivery) sends each message once', async () => {
      await optIns(2);
      const c = await newCampaign();
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      await camp.launch(STORE, actor, String(c._id));
      const [ids] = queued.splice(0);
      await Promise.all([camp.sendBatch(ids), camp.sendBatch(ids)]);
      await camp.sendBatch(ids);
      expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(2);
    });

    it('a transient provider error is retried (up to 3 attempts), a permanent one fails at once', async () => {
      await optIns(2);
      const c = await newCampaign();
      provider.sendTemplateMessage.mockImplementation(async (_a: any, to: string) => (to === keyOf(0) ? { success: false, error: 'HTTP 429 rate limit' } : { success: false, error: 'invalid recipient' }));
      await camp.launch(STORE, actor, String(c._id));
      await sendAll();
      expect(((await m.messages.findOne({ contactKey: keyOf(1) }).lean()) as any)).toMatchObject({ status: 'failed', error: 'invalid recipient' });
      expect(((await m.messages.findOne({ contactKey: keyOf(0) }).lean()) as any)).toMatchObject({ status: 'queued', attempts: 1 });
      await camp.dispatch(String(c._id)); await sendAll();
      await camp.dispatch(String(c._id)); await sendAll();
      expect(((await m.messages.findOne({ contactKey: keyOf(0) }).lean()) as any)).toMatchObject({ status: 'failed', attempts: 3 });
      expect(((await m.campaigns.findById(c._id).lean()) as any).status).toBe('completed');
    });

    it('cancel stops what is still waiting; a message stuck in "sending" is failed, never re-sent', async () => {
      await optIns(3);
      const c = await newCampaign({ dailyLimit: 1 });
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      await camp.launch(STORE, actor, String(c._id));
      const s: any = await camp.cancel(STORE, actor, String(c._id));
      expect(s.campaign.status).toBe('canceled');
      expect(s.skipped).toBeGreaterThanOrEqual(2);
      await sendAll();
      expect(provider.sendTemplateMessage).not.toHaveBeenCalled(); // the claimed message sees a canceled campaign
      await m.messages.create({ storeId: STORE, campaignId: oid(), channel: 'whatsapp', contactKey: 'x', status: 'sending', sendingAt: new Date(Date.now() - 3600_000) });
      expect(await camp.failStuck()).toBe(1);
    });

    it('stats never invent a price; log is store-scoped and paged', async () => {
      await optIns(2);
      const c = await newCampaign();
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      await camp.launch(STORE, actor, String(c._id)); await sendAll();
      const s: any = await camp.stats(STORE, String(c._id));
      expect(s).toMatchObject({ sent: 2, delivered: 0, billing: { billedUnit: 'delivered template message', deliveredMessages: 0 } });
      expect(JSON.stringify(s.billing)).not.toMatch(/\$|usd|rs\.?\s?\d/i);
      expect((await camp.messageLog(STORE, String(c._id), { limit: 1 })).items).toHaveLength(1);
      await expect(camp.stats(OTHER, String(c._id))).rejects.toThrow(/not found/i);
      await expect(camp.messageLog(OTHER, String(c._id), {})).rejects.toThrow(/not found/i);
    });
  });

  describe('webhook', () => {
    beforeEach(wipe);
    const payload = (value: any) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE_ID }, ...value } }] }] });

    it('delivery reports move a message forward only, set times, record failures, and ignore unknown ids and other numbers', async () => {
      await optIns(1);
      const c = await newCampaign();
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'wamid-1' });
      await camp.launch(STORE, actor, String(c._id)); await sendAll();
      const get = async () => (await m.messages.findOne({ providerMessageId: 'wamid-1' }).lean()) as any;

      await hook.handle(payload({ statuses: [{ id: 'wamid-1', status: 'delivered' }] }));
      expect((await get()).status).toBe('delivered');
      await hook.handle(payload({ statuses: [{ id: 'wamid-1', status: 'sent' }] })); // late, older report
      expect((await get()).status).toBe('delivered');
      await hook.handle(payload({ statuses: [{ id: 'wamid-1', status: 'read' }] }));
      expect(await get()).toMatchObject({ status: 'read' });
      expect((await get()).readAt).toBeTruthy();
      await hook.handle(payload({ statuses: [{ id: 'wamid-1', status: 'failed', errors: [{ code: 1, title: 'x' }] }] }));
      expect((await get()).status).toBe('read'); // failure never overwrites a delivered message
      expect(await hook.handle(payload({ statuses: [{ id: 'nope', status: 'read' }] }))).toEqual({ statuses: 0, optedOut: 0 });
      expect(await hook.handle({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'someone-else' }, statuses: [{ id: 'wamid-1', status: 'failed' }] } }] }] })).toEqual({ statuses: 0, optedOut: 0 });
      expect((await get()).status).toBe('read');
      expect(await hook.handle('garbage' as any)).toEqual({ statuses: 0, optedOut: 0 });
    });

    it('a failed report is recorded with its reason when the message was only sent', async () => {
      await optIns(1);
      const c = await newCampaign();
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'wamid-2' });
      await camp.launch(STORE, actor, String(c._id)); await sendAll();
      await hook.handle(payload({ statuses: [{ id: 'wamid-2', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] }));
      expect(((await m.messages.findOne({ providerMessageId: 'wamid-2' }).lean()) as any)).toMatchObject({ status: 'failed', error: '131026 Message undeliverable' });
    });

    it('a STOP reply opts the person out at once and cancels their waiting messages; other words and other contacts are untouched', async () => {
      await optIns(3);
      const c = await newCampaign({ dailyLimit: 1 });
      provider.sendTemplateMessage.mockResolvedValue({ success: true, messageId: 'w' });
      await camp.launch(STORE, actor, String(c._id)); // 1 claimed, 2 waiting
      const r = await hook.handle(payload({ messages: [{ from: keyOf(2), type: 'text', text: { body: ' STOP ' } }, { from: keyOf(1), type: 'text', text: { body: 'thanks!' } }, { from: keyOf(0), type: 'button', button: { text: 'Stop promotions' } }] }));
      expect(r.optedOut).toBe(1);
      expect((await consent.statusFor(STORE, 'whatsapp', [keyOf(2), keyOf(1)])).get(keyOf(2))).toBe('opted_out');
      expect((await consent.statusFor(STORE, 'whatsapp', [keyOf(1)])).get(keyOf(1))).toBe('opted_in');
      expect(((await m.messages.findOne({ contactKey: keyOf(2) }).lean()) as any).status).toBe('skipped_opted_out');
      await hook.handle(payload({ messages: [{ from: keyOf(0), type: 'button', button: { text: 'STOP' } }] }));
      expect((await consent.statusFor(STORE, 'whatsapp', [keyOf(0)])).get(keyOf(0))).toBe('opted_out');
    });

    it('a STOP sent to one store\'s number does not opt the person out of another store', async () => {
      await consent.optIn(OTHER, 'whatsapp', phone(7), { source: 'manual' });
      await consent.optIn(STORE, 'whatsapp', phone(7), { source: 'manual' });
      await hook.handle(payload({ messages: [{ from: keyOf(7), type: 'text', text: { body: 'stop' } }] }));
      expect((await consent.statusFor(STORE, 'whatsapp', [keyOf(7)])).get(keyOf(7))).toBe('opted_out');
      expect((await consent.statusFor(OTHER, 'whatsapp', [keyOf(7)])).get(keyOf(7))).toBe('opted_in');
    });
  });
});
