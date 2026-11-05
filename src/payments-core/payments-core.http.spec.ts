/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { GUARDS_METADATA, INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { makePaymentsFixture } from './testing/payments-harness';
import { PaymentsCoreController } from './payments-core.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { PaymentsWebhookService } from './payments-webhook.service';
import { MockControlController } from './mock-control.controller';
import { buildProviders } from './payments-core.module';
import { PosAuthGuard } from '../pos/guards/pos-auth.guard';
import { PosEntitlementGuard } from '../pos/guards/pos-entitlement.guard';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';

jest.setTimeout(120_000);

const routes = () => Object.getOwnPropertyNames(PaymentsCoreController.prototype)
  .filter((n) => n !== 'constructor' && Reflect.getMetadata(PATH_METADATA, (PaymentsCoreController.prototype as any)[n]) !== undefined)
  .map((n) => {
    const fn = (PaymentsCoreController.prototype as any)[n];
    const guards: any[] = [...(Reflect.getMetadata(GUARDS_METADATA, PaymentsCoreController) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, fn) ?? [])];
    const interceptors: any[] = [...(Reflect.getMetadata(INTERCEPTORS_METADATA, PaymentsCoreController) ?? []), ...(Reflect.getMetadata(INTERCEPTORS_METADATA, fn) ?? [])];
    return { key: `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)]} ${Reflect.getMetadata(PATH_METADATA, fn)}`, auth: guards.includes(PosAuthGuard), plan: guards.includes(PosEntitlementGuard), idem: interceptors.includes(IdempotencyInterceptor) };
  });

describe('route guards of the POS payment routes', () => {
  it('every route needs POS auth; only creating a payment needs an active POS plan; money-moving routes are idempotent', () => {
    const r = routes();
    expect(r.map((x) => x.key).sort()).toEqual(['GET attention', 'GET intents/:id', 'POST intents', 'POST intents/:id/cancel', 'POST intents/:id/presented', 'POST intents/:id/reconcile', 'POST intents/:id/refunds']);
    expect(r.every((x) => x.auth)).toBe(true);
    expect(r.filter((x) => x.plan).map((x) => x.key)).toEqual(['POST intents']); // a lapsed plan can still refund / reconcile what was already paid
    expect(r.filter((x) => x.idem).map((x) => x.key).sort()).toEqual(['POST intents', 'POST intents/:id/reconcile', 'POST intents/:id/refunds']);
  });
});

describe('POST /api/payments/webhooks/:provider (raw body, signature, 2xx)', () => {
  let app: INestApplication; let x: Awaited<ReturnType<typeof makePaymentsFixture>>;
  beforeAll(async () => {
    x = await makePaymentsFixture();
    const mod = await Test.createTestingModule({ controllers: [PaymentsWebhookController], providers: [{ provide: PaymentsWebhookService, useValue: x.webhooks }] }).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
  });
  afterAll(async () => { await app.close(); await x.stop(); });

  it('a correctly signed webhook is accepted (200) with the exact raw bytes; the payment is confirmed', async () => {
    const v = await x.create();
    const w = x.mock.buildWebhook({ kind: 'confirmed', providerRef: await x.providerRefOf(v.id), amountMinor: 150000, eventId: 'http-1' });
    await request(app.getHttpServer()).post('/api/payments/webhooks/mock').set(w.headers).send(w.body.toString()).expect(200).expect({ received: true, duplicate: false });
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    // the same notification again → still 200, nothing new
    await request(app.getHttpServer()).post('/api/payments/webhooks/mock').set(w.headers).send(w.body.toString()).expect(200).expect({ received: true, duplicate: true });
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
  });

  it('401 for a bad signature, a stale timestamp and a missing signature; 404 for an unknown provider; no unauthenticated way to confirm', async () => {
    const v = await x.create();
    const ref = await x.providerRefOf(v.id);
    const bad = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 150000, badSignature: true });
    await request(app.getHttpServer()).post('/api/payments/webhooks/mock').set(bad.headers).send(bad.body.toString()).expect(401);
    const stale = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 150000, at: new Date(Date.now() - 3600_000) });
    await request(app.getHttpServer()).post('/api/payments/webhooks/mock').set(stale.headers).send(stale.body.toString()).expect(401);
    await request(app.getHttpServer()).post('/api/payments/webhooks/mock').send({ type: 'confirmed', charge: ref }).expect(401);
    await request(app.getHttpServer()).post('/api/payments/webhooks/unknown').send({}).expect(404);
    expect(await x.eventTypes(v.id)).toEqual(['created']);
  });
});

describe('mock control endpoint ("customer paid" button for demos) is hard-disabled outside dev', () => {
  it('403 unless PAYMENTS_MOCK_CONTROL=true, never in production; when on it confirms the payment through a real signed webhook', async () => {
    const x = await makePaymentsFixture();
    const ctl = new MockControlController([x.mock], x.core, x.webhooks);
    const v = await x.create();
    await expect(ctl.simulate({ intentId: v.id, scenario: 'confirm' })).rejects.toMatchObject({ status: 403 });
    process.env.PAYMENTS_MOCK_CONTROL = 'true';
    try {
      const prodEnv = process.env.NODE_ENV; (process.env as any).NODE_ENV = 'production';
      await expect(ctl.simulate({ intentId: v.id, scenario: 'confirm' })).rejects.toMatchObject({ status: 403 });
      (process.env as any).NODE_ENV = prodEnv;
      await ctl.simulate({ intentId: v.id, scenario: 'confirm' });
      expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    } finally { delete process.env.PAYMENTS_MOCK_CONTROL; }
    await x.stop();
  });

  it('the mock provider is not even registered in production, and there is no silent provider fallback there', () => {
    expect(buildProviders({ NODE_ENV: 'production' } as any)).toEqual([]);
    expect(buildProviders({ NODE_ENV: 'development' } as any).map((p) => p.key)).toEqual(['mock']);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { paymentsConfig } = require('./payments-config');
    expect(paymentsConfig({ NODE_ENV: 'production' } as any).providerKey).toBe('');
    expect(paymentsConfig({ NODE_ENV: 'test' } as any).providerKey).toBe('mock');
  });
});
