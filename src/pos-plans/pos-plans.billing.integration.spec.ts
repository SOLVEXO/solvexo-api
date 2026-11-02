/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdminPosPlansService } from './admin-pos-plans.service';
import { PosPlansService } from './pos-plans.service';
import { PosPlansWebhookService } from './webhooks/pos-plans-webhook.service';
import { assertWithinPosPlanLimit } from './pos-plan-limits.util';
import { PosService } from '../pos/pos.service';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5E: the POS plan billing lifecycle against a REAL MongoDB — webhook idempotency, stacking, refunds/disputes, admin interplay, plan limits. */
jest.setTimeout(120_000);
const DAY = 86_400_000;
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const activity = { log: jest.fn().mockResolvedValue(undefined) };
const webhook = () => new PosPlansWebhookService({ repositories: h.repos } as any, {} as any, {} as any);
const admin = () => new AdminPosPlansService({ repositories: h.repos } as any, activity as any);
const plans = () => new PosPlansService({ repositories: h.repos } as any, {} as any);
const actor = { adminId: 'admin-1' };

const mkPlan = async (over: any = {}) => String((await h.repos.posPlanModel.create({ name: '30 day', price: 20, currency: 'USD', durationInDays: 30, ...over }))._id);
const paid = (s: any, planId: string, id: string, days = 30, pi = `pi_${id}`) => ({
  type: 'checkout.session.completed',
  data: { object: { id, mode: 'payment', payment_status: 'paid', payment_intent: pi, metadata: { type: 'pos_purchase', storeId: s.storeId, sellerId: s.sellerId, planId, durationInDays: String(days) } } },
});
const latest = async (storeId: string): Promise<any> => h.repos.posPurchaseModel.findOne({ storeId }).sort({ purchasedAt: -1 }).lean();
const status = async (s: any) => ((await plans().getStatus(s.storeId, s.sellerId)) as any).data;
const tick = () => new Promise((r) => setTimeout(r, 15)); // purchasedAt ordering

describe('webhook: purchase', () => {
  it('a paid checkout creates an active plan; a redelivered event is a no-op', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    const ev = paid(s, planId, 'cs_1');
    expect(await webhook().handleEvent(ev)).toMatchObject({ received: true });
    expect(await webhook().handleEvent(ev)).toMatchObject({ duplicate: true });
    expect(await h.repos.posPurchaseModel.countDocuments({ storeId: s.storeId })).toBe(1);
    const st = await status(s);
    expect(st.status).toBe('active');
    expect(st.daysRemaining).toBe(30);
    expect(st.planName).toBe('30 day');
  });

  it('concurrent redeliveries still produce exactly one purchase', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    const ev = paid(s, planId, 'cs_race');
    await Promise.all([webhook().handleEvent(ev), webhook().handleEvent(ev), webhook().handleEvent(ev)]);
    expect(await h.repos.posPurchaseModel.countDocuments({ storeId: s.storeId })).toBe(1);
  });

  it('an unpaid (async-method) session grants nothing; the later async_payment_succeeded does', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    const ev: any = paid(s, planId, 'cs_async');
    ev.data.object.payment_status = 'unpaid';
    expect(await webhook().handleEvent(ev)).toMatchObject({ pending: true });
    expect(await h.repos.posPurchaseModel.countDocuments({})).toBe(0);
    const ok = { ...paid(s, planId, 'cs_async'), type: 'checkout.session.async_payment_succeeded' };
    await webhook().handleEvent(ok);
    expect(await h.repos.posPurchaseModel.countDocuments({})).toBe(1);
  });

  it('ignores other products / missing metadata', async () => {
    const s = await seedStore(h);
    await webhook().handleEvent({ type: 'checkout.session.completed', data: { object: { id: 'x', mode: 'payment', metadata: { type: 'something_else' } } } });
    await webhook().handleEvent({ type: 'checkout.session.completed', data: { object: { id: 'y', mode: 'payment', metadata: { type: 'pos_purchase', storeId: s.storeId } } } });
    expect(await h.repos.posPurchaseModel.countDocuments({})).toBe(0);
  });

  it('buying BEFORE expiry stacks: the new term starts when the current one ends', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_a'));
    const first = await latest(s.storeId);
    await tick();
    await webhook().handleEvent(paid(s, planId, 'cs_b'));
    const second = await latest(s.storeId);
    expect(new Date(second.expiresAt).getTime()).toBe(new Date(first.expiresAt).getTime() + 30 * DAY);
    expect((await status(s)).daysRemaining).toBe(60);
  });

  it('buying AFTER expiry starts from now (no credit for the gap)', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_old'));
    await h.repos.posPurchaseModel.collection.updateOne({ storeId: s.storeId }, { $set: { expiresAt: new Date(Date.now() - 5 * DAY), purchasedAt: new Date(Date.now() - 35 * DAY) } });
    await webhook().handleEvent(paid(s, planId, 'cs_new'));
    expect((await status(s)).daysRemaining).toBe(30);
  });
});

describe('webhook: refunds and disputes', () => {
  const refund = (pi: string, amount = 2000, refunded = 2000) => ({ type: 'charge.refunded', data: { object: { payment_intent: pi, amount, amount_refunded: refunded } } });
  const dispute = (pi: string) => ({ type: 'charge.dispute.created', data: { object: { payment_intent: pi } } });

  it('a full refund of the only purchase ends access; redelivery is a no-op', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    expect(await webhook().handleEvent(refund('pi_cs_1'))).toMatchObject({ reversed: true });
    expect((await status(s)).status).toBe('expired');
    expect(await webhook().handleEvent(refund('pi_cs_1'))).toMatchObject({ duplicate: true });
    expect((await latest(s.storeId)).reversedReason).toBe('refunded');
  });

  it('a partial refund changes nothing', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    expect(await webhook().handleEvent(refund('pi_cs_1', 2000, 500))).toMatchObject({ ignored: 'partial_refund' });
    expect((await status(s)).status).toBe('active');
  });

  it('refunding the NEWER of two stacked purchases falls back to where the first ended', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_a'));
    const first = await latest(s.storeId);
    await tick();
    await webhook().handleEvent(paid(s, planId, 'cs_b'));
    await webhook().handleEvent(refund('pi_cs_b'));
    expect(Math.abs(new Date((await latest(s.storeId)).expiresAt).getTime() - new Date(first.expiresAt).getTime())).toBeLessThan(1000);
    expect((await status(s)).status).toBe('active');
  });

  it('refunding the OLDER of two stacked purchases shortens the newer expiry by its days', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_a'));
    await tick();
    await webhook().handleEvent(paid(s, planId, 'cs_b'));
    const before = new Date((await latest(s.storeId)).expiresAt).getTime();
    await webhook().handleEvent(refund('pi_cs_a'));
    expect(Math.abs(new Date((await latest(s.storeId)).expiresAt).getTime() - (before - 30 * DAY))).toBeLessThan(2000);
  });

  it('a dispute revokes the same way', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await webhook().handleEvent(dispute('pi_cs_1'));
    expect((await status(s)).status).toBe('expired');
    expect((await latest(s.storeId)).reversedReason).toBe('disputed');
  });

  it('refunding a purchase whose term already ended does not eat into a newer manual extension', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_old'));
    await h.repos.posPurchaseModel.collection.updateOne({ storeId: s.storeId }, { $set: { expiresAt: new Date(Date.now() - 2 * DAY), purchasedAt: new Date(Date.now() - 32 * DAY) } });
    await admin().extendManually({ storeId: s.storeId, days: 10, reason: 'goodwill' } as any, actor);
    const before = new Date((await latest(s.storeId)).expiresAt).getTime();
    await webhook().handleEvent(refund('pi_cs_old'));
    // the refunded row's term is over, but the latest row is still running: only the stamp + shortening rule apply
    const after = new Date((await latest(s.storeId)).expiresAt).getTime();
    expect(after).toBe(before); // untouched: the refunded term had already ended
  });
});

describe('admin manual grant / extend / revoke with paid plans', () => {
  it('extend stacks on top of a paid plan; revoke ends everything; a later paid purchase starts from now', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await tick();
    await admin().extendManually({ storeId: s.storeId, days: 10, reason: 'goodwill' } as any, actor);
    expect((await status(s)).daysRemaining).toBe(40);
    await admin().revokeManually({ storeId: s.storeId, reason: 'abuse' } as any, actor);
    expect((await status(s)).status).toBe('expired');
    await webhook().handleEvent(paid(s, planId, 'cs_2'));
    expect((await status(s)).daysRemaining).toBe(30);
  });

  it('grant is refused while a paid plan is active; works once it lapsed', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await expect(admin().grantManually({ storeId: s.storeId, days: 5, reason: 'x' } as any, actor)).rejects.toBeInstanceOf(BadRequestException);
    await admin().revokeManually({ storeId: s.storeId, reason: 'x' } as any, actor);
    await admin().grantManually({ storeId: s.storeId, days: 5, reason: 'x' } as any, actor);
    expect((await status(s)).daysRemaining).toBe(5);
  });

  it('a refund event after an admin revoke does not resurrect or double-shorten anything', async () => {
    const s = await seedStore(h); const planId = await mkPlan();
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await admin().revokeManually({ storeId: s.storeId, reason: 'x' } as any, actor);
    await webhook().handleEvent({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_cs_1', amount: 100, amount_refunded: 100 } } });
    expect((await status(s)).status).toBe('expired');
  });

  it('a manual row is never reversed by a Stripe event', async () => {
    const s = await seedStore(h);
    await admin().grantManually({ storeId: s.storeId, days: 10, reason: 'x' } as any, actor);
    await webhook().handleEvent({ type: 'charge.refunded', data: { object: { payment_intent: null, amount: 100, amount_refunded: 100 } } });
    expect((await status(s)).status).toBe('active');
  });
});

describe('optional plan limits', () => {
  const posSvc = () => new PosService({ repositories: h.repos } as any, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);

  it('registers: enforced when the active plan sets maxRegisters; unlimited when null; ignored without a plan', async () => {
    const s = await seedStore(h); // seed has 1 register
    await expect(posSvc().addRegister(s.sellerId, s.storeId, { name: 'R2' })).resolves.toBeTruthy(); // no plan → unlimited
    const planId = await mkPlan({ maxRegisters: 2 });
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await expect(posSvc().addRegister(s.sellerId, s.storeId, { name: 'R3' })).rejects.toMatchObject({ response: { code: 'POS_PLAN_LIMIT' } }); // already 2
    await h.repos.posPlanModel.updateOne({ _id: planId }, { $set: { maxRegisters: null } });
    await expect(posSvc().addRegister(s.sellerId, s.storeId, { name: 'R3' })).resolves.toBeTruthy();
  });

  it('employees: enforced at maxEmployees', async () => {
    const s = await seedStore(h); // 2 employees seeded
    const planId = await mkPlan({ maxEmployees: 2 });
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await expect(posSvc().addEmployee(s.sellerId, { storeId: s.storeId, name: 'N', email: 'n@x.com', pin: '1234', role: 'cashier' } as any)).rejects.toMatchObject({ response: { code: 'POS_PLAN_LIMIT' } });
  });

  it('a lapsed plan and a manual grant without a plan are not limited', async () => {
    const s = await seedStore(h);
    const planId = await mkPlan({ maxLocations: 1 });
    await webhook().handleEvent(paid(s, planId, 'cs_1'));
    await h.repos.posPurchaseModel.collection.updateOne({ storeId: s.storeId }, { $set: { expiresAt: new Date(Date.now() - DAY) } });
    await expect(assertWithinPosPlanLimit(h.repos as any, s.storeId, 'locations', 5)).resolves.toBeUndefined();
    await admin().grantManually({ storeId: s.storeId, days: 5, reason: 'x' } as any, actor);
    await expect(assertWithinPosPlanLimit(h.repos as any, s.storeId, 'locations', 5)).resolves.toBeUndefined();
  });
});
