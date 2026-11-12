/* eslint-disable prettier/prettier */
/**
 * Email campaigns on a real MongoDB, calling the service / processor functions directly (no Redis, no SMTP):
 * consent + deleted-account exclusion, store isolation, one send per recipient, retry/backoff and final failure.
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit email-campaigns.integration
 */
import mongoose, { Connection } from 'mongoose';
import { EmailCampaignsService } from './email-campaigns.service';
import { EmailCampaignsProcessor } from './email-campaigns.processor';
import { EmailCampaignSchema } from './schemas/email-campaign.schema';
import { EmailCampaignSendSchema } from './schemas/email-campaign-send.schema';
import { NewsletterSubscriberSchema } from '../newsletter/schemas/newsletter-subscriber.schema';
import { UserSchema } from '../users/schemas/user.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('email campaigns (real Mongo, direct calls)', () => {
  let conn: Connection;
  let repos: any;
  let queued: any[];
  let svc: any;

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `camp_it_${Date.now()}` }).asPromise();
    repos = {
      emailCampaignModel: conn.model('EmailCampaign', EmailCampaignSchema),
      emailCampaignSendModel: conn.model('EmailCampaignSend', EmailCampaignSendSchema),
      newsletterSubscriberModel: conn.model('NewsletterSubscriber', NewsletterSubscriberSchema),
      userModel: conn.model('User', UserSchema),
      orderModel: conn.model('Order', new mongoose.Schema({}, { strict: false })),
      checkoutModel: conn.model('Checkout', new mongoose.Schema({}, { strict: false })),
      storeModel: conn.model('Store', new mongoose.Schema({ _id: String }, { strict: false })),
    };
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  beforeEach(async () => {
    for (const m of Object.values(repos) as any[]) await m.deleteMany({});
    queued = [];
    svc = Object.create(EmailCampaignsService.prototype);
    svc.db = { repositories: repos };
    svc.entitlementsService = { assertFeatureAllowed: async () => undefined };
    svc.activityLogService = { log: () => undefined };
    svc.queue = { add: async (_n: string, data: any, opts: any) => { queued.push({ data, opts }); } };
    svc.customerSegments = { resolveMembers: async () => null };
    svc.logger = { warn: () => undefined, log: () => undefined };
    svc.applySegment = async (_s: string, r: any) => r;
  });

  const sub = (storeId: string, email: string, extra: any = {}) =>
    repos.newsletterSubscriberModel.create({ storeId, email, isActive: true, unsubscribeToken: `t-${storeId}-${email}`, source: 'footer', ...extra });
  const campaign = async (storeId: string) => repos.emailCampaignModel.create({ storeId, sellerId: 'sel1', name: 'C', subject: 'Hi', message: 'Hello', audience: 'all', status: 'draft' });

  it('emails only active subscribers of THAT store; unsubscribed, deleted-account and other-store people are excluded', async () => {
    await sub('s1', 'ok@x.com');
    await sub('s1', 'out@x.com', { isActive: false });
    await sub('s1', 'gone@x.com');
    await sub('s2', 'other@x.com');
    await repos.userModel.create({ name: 'Gone', email: 'gone@x.com', password: 'x', role: 'user', isDelete: true, storeId: 's1' });
    const c = await campaign('s1');
    const res = await svc.executeSend(c);
    expect(res.recipientCount).toBe(1);
    expect(queued.map((q) => q.data.email)).toEqual(['ok@x.com']);
    expect(await repos.emailCampaignSendModel.countDocuments({ campaignId: String(c._id) })).toBe(1);
  });

  it('a campaign with nobody to email is marked failed and queues nothing', async () => {
    await sub('s1', 'out@x.com', { isActive: false });
    const c = await campaign('s1');
    const res = await svc.executeSend(c);
    expect(res.recipientCount).toBe(0);
    expect(queued).toHaveLength(0);
    expect((await repos.emailCampaignModel.findById(c._id)).status).toBe('failed');
  });

  it('every job carries an unsubscribe link and the 4-attempt exponential backoff', async () => {
    await sub('s1', 'a@x.com');
    await svc.executeSend(await campaign('s1'));
    expect(queued[0].data.unsubscribeUrl).toContain('t-s1-a@x.com');
    expect(queued[0].opts.attempts).toBe(4);
    expect(queued[0].opts.backoff.type).toBe('exponential');
  });

  describe('processor', () => {
    const run = async (sendOk: boolean, attemptsMade: number) => {
      await sub('s1', 'a@x.com');
      const c = await campaign('s1');
      await svc.executeSend(c);
      const job: any = { data: queued[0].data, opts: { attempts: 4 }, attemptsMade };
      const mail = jest.fn(async () => sendOk);
      const proc: any = new EmailCampaignsProcessor({ sendMail: mail } as any, svc);
      return { c, job, proc, mail };
    };

    it('success marks the recipient sent once; a redelivery never mails twice', async () => {
      const { c, job, proc, mail } = await run(true, 0);
      await proc.process(job);
      await proc.process(job);
      expect(mail).toHaveBeenCalledTimes(1);
      const camp = await repos.emailCampaignModel.findById(c._id);
      expect(camp.sentCount).toBe(1);
      expect(camp.status).toBe('sent');
    });

    it('a failure before the last attempt throws (so BullMQ retries) and leaves the recipient pending', async () => {
      const { c, job, proc } = await run(false, 0);
      await expect(proc.process(job)).rejects.toThrow();
      const camp = await repos.emailCampaignModel.findById(c._id);
      expect(camp.failedCount ?? 0).toBe(0);
      expect(camp.status).toBe('sending');
    });

    it('the last failed attempt records a permanent failure once and finalises the campaign as failed', async () => {
      const { c, job, proc } = await run(false, 3);
      await proc.process(job);
      await proc.process(job);
      const camp = await repos.emailCampaignModel.findById(c._id);
      expect(camp.failedCount).toBe(1);
      expect(camp.status).toBe('failed');
    });
  });
});
