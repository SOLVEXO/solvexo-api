/* eslint-disable prettier/prettier */
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { PosPlansService } from './pos-plans.service';
import { PosCheckoutStatusController } from './pos-plans.controller';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5G.1: PUBLIC checkout-session status for the portal success page. Real Mongo + HTTP, Stripe stubbed. */
jest.setTimeout(120_000);
let h: MongoHarness;
let app: any;
const sessions: Record<string, any> = {};
const retrieve = jest.fn(async (id: string) => { if (!sessions[id]) throw new Error('No such checkout.session'); return sessions[id]; });
const SID = 'cs_test_a1B2c3D4e5F6g7H8i9J0';
const posSession = (o: any = {}) => ({ id: SID, mode: 'payment', status: 'complete', payment_status: 'paid', customer_details: { email: 'secret@x.com' }, amount_total: 4900, metadata: { type: 'pos_purchase', storeId: 'store-1', sellerId: 's1', planId: 'p1' }, ...o });

beforeAll(async () => {
  h = await startMongoHarness();
  const service = new PosPlansService({ repositories: h.repos } as any, { stripeClient: { checkout: { sessions: { retrieve } } } } as any);
  const mod = await Test.createTestingModule({ controllers: [PosCheckoutStatusController], providers: [{ provide: PosPlansService, useValue: service }] }).compile();
  app = mod.createNestApplication();
  await app.init();
});
afterAll(async () => { await app?.close(); await h?.stop(); });
beforeEach(async () => { await h.reset(); for (const k of Object.keys(sessions)) delete sessions[k]; retrieve.mockClear(); });

const get = (id?: string) => request(app.getHttpServer()).get('/api/pos-checkout/session-status').query(id === undefined ? {} : { sessionId: id });
const purchase = (sessionId: string) => h.repos.posPurchaseModel.collection.insertOne({ storeId: 'store-1', sellerId: 's1', planId: 'p1', planNameSnapshot: 'Pro', priceSnapshot: 49, currencySnapshot: 'USD', durationInDaysSnapshot: 30, stripeCheckoutSessionId: sessionId, purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), source: 'stripe', _id: new Types.ObjectId() });

describe('GET /api/pos-checkout/session-status (no auth)', () => {
  it('paid but the webhook has not landed yet → paid / planActivated:false', async () => {
    sessions[SID] = posSession();
    const res = await get(SID).expect(200);
    expect(res.body).toEqual({ success: true, data: { status: 'paid', planActivated: false, storeId: 'store-1' } });
  });
  it('paid and the webhook processed it (PosPurchase exists for the session) → planActivated:true', async () => {
    sessions[SID] = posSession(); await purchase(SID);
    expect((await get(SID).expect(200)).body.data).toEqual({ status: 'paid', planActivated: true, storeId: 'store-1' });
  });
  it('open / expired / complete-but-unpaid map to open | expired | open', async () => {
    sessions[SID] = posSession({ status: 'open', payment_status: 'unpaid' });
    expect((await get(SID)).body.data.status).toBe('open');
    sessions[SID] = posSession({ status: 'expired', payment_status: 'unpaid' });
    expect((await get(SID)).body.data.status).toBe('expired');
    sessions[SID] = posSession({ status: 'complete', payment_status: 'unpaid' });
    expect((await get(SID)).body.data.status).toBe('open');
  });
  it('returns ONLY status/planActivated/storeId — no amounts, emails or customer data', async () => {
    sessions[SID] = posSession();
    const body = JSON.stringify((await get(SID)).body);
    expect(body).not.toMatch(/secret@x\.com|4900|amount|email|customer|sellerId|planId/);
  });
  it('non-POS sessions, unknown ids, malformed ids and a missing id are all the same plain unknown (and malformed ids never reach Stripe)', async () => {
    const unknown = { success: true, data: { status: 'unknown', planActivated: false, storeId: null } };
    sessions['cs_test_NotPosSession123456'] = posSession({ id: 'cs_test_NotPosSession123456', metadata: { type: 'subscription', storeId: 'store-1' } });
    sessions['cs_test_SubscriptionMode12345'] = posSession({ mode: 'subscription' });
    expect((await get('cs_test_NotPosSession123456').expect(200)).body).toEqual(unknown);
    expect((await get('cs_test_SubscriptionMode12345').expect(200)).body).toEqual(unknown);
    expect((await get('cs_test_DoesNotExist123456789').expect(200)).body).toEqual(unknown);
    retrieve.mockClear();
    for (const bad of ['', 'x', 'pi_123', 'cs_test_', '../etc/passwd', `cs_test_${'a'.repeat(300)}`]) expect((await get(bad).expect(200)).body).toEqual(unknown);
    expect((await get().expect(200)).body).toEqual(unknown);
    expect(retrieve).not.toHaveBeenCalled();
  });
  it('is throttled per IP (30/min) via @Throttle on the route', () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', PosCheckoutStatusController.prototype.sessionStatus);
    expect(limit).toBe(30);
  });
});

describe('checkout-session creation DTO', () => {
  it('accepts the portal’s success URL carrying Stripe’s {CHECKOUT_SESSION_ID} placeholder', async () => {
    const dto = Object.assign(new CreateCheckoutSessionDto(), { planId: 'p1', successUrl: 'https://account.solvexo.store/plan/success?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://account.solvexo.store/plan/cancel' });
    expect(await validate(dto)).toHaveLength(0);
  });
});
