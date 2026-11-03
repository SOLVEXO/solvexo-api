/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { GUARDS_METADATA, INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';

const routes = () => Object.getOwnPropertyNames(PosController.prototype)
  .filter((n) => n !== 'constructor' && Reflect.getMetadata(PATH_METADATA, (PosController.prototype as any)[n]) !== undefined)
  .map((n) => {
    const fn = (PosController.prototype as any)[n];
    const guards: any[] = [...(Reflect.getMetadata(GUARDS_METADATA, PosController) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, fn) ?? [])];
    const interceptors: any[] = [...(Reflect.getMetadata(INTERCEPTORS_METADATA, PosController) ?? []), ...(Reflect.getMetadata(INTERCEPTORS_METADATA, fn) ?? [])];
    return { key: `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)]} ${Reflect.getMetadata(PATH_METADATA, fn)}`, plan: guards.includes(PosEntitlementGuard), idem: interceptors.includes(IdempotencyInterceptor) };
  });

/**
 * Decision Q4 (phase5_decisions.md): when a store's POS plan lapses the till may no longer SELL or OPEN a shift, but must still
 * let the owner reconcile: close the open shift, refund/void, move cash, read reports. This pins that split at the route level
 * so a refactor (e.g. a class-level guard, or a new selling route that forgets the guard) cannot silently change it.
 * Real-DB behaviour of the guard itself is in pos-entitlement.guard.spec.ts / pos.integration.spec.ts.
 */
describe('which POS routes need an active POS plan (decision Q4)', () => {
  const GATED = [
    'GET products/search', 'GET products/:storeId', 'GET products/barcode/:storeId/:barcode',
    'POST sessions/open', 'POST sales', 'POST sales/quote', 'POST sales/:saleId/complete', 'PATCH sales/:saleId/items',
  ];
  const MUST_STAY_OPEN = [
    'POST sessions/close', 'POST sessions/:sessionId/force-close', 'POST sessions/:sessionId/cash-adjustment', 'GET sessions/:sessionId/report',
    'POST sales/:saleId/refund', 'POST sales/:saleId/void', 'DELETE sales/:saleId/discard', 'GET sales', 'GET sales/:saleId',
    'POST pin-login', 'POST pin-logout', 'GET subscription/:storeId', 'POST offline-discards', 'POST sales/:saleId/resolve-review',
    'GET reports/daily', 'GET settings/:storeId',
  ];

  it('exactly the selling / shift-opening routes are gated — nothing more, nothing less', () => {
    expect(routes().filter((r) => r.plan).map((r) => r.key).sort()).toEqual([...GATED].sort());
  });

  it('closing, refunding, voiding, cash movements, reports and PIN login stay available after the plan lapses', () => {
    const byKey = new Map(routes().map((r) => [r.key, r.plan]));
    for (const k of MUST_STAY_OPEN) expect({ route: k, exists: byKey.has(k), gated: byKey.get(k) }).toEqual({ route: k, exists: true, gated: false });
  });
});

/**
 * Gap #2: a retried money-moving request must never repeat its effect. The app sends an Idempotency-Key on each of these; the
 * server only honours it where the interceptor is wired, so a new/renamed money route without it would silently double-charge on retry.
 */
describe('which POS routes are idempotent (Idempotency-Key honoured)', () => {
  const IDEMPOTENT = [
    'POST sessions/open', 'POST sessions/close', 'POST sessions/:sessionId/cash-adjustment', 'POST sales',
    'POST sales/:saleId/complete', 'POST sales/:saleId/refund', 'POST sales/:saleId/void', 'POST offline-discards',
  ];

  it('every sale / refund / void / cash / shift mutation is wrapped by the IdempotencyInterceptor', () => {
    const byKey = new Map(routes().map((r) => [r.key, r.idem]));
    for (const k of IDEMPOTENT) expect({ route: k, wired: byKey.get(k) }).toEqual({ route: k, wired: true });
  });

  it('no other mutating money route exists without it (a new POST/PATCH/DELETE on sales/sessions must be classified here)', () => {
    const NOT_MONEY = /^(POST pin-(login|logout)|POST devices|POST employees|POST registers|POST shifts|POST locations|POST sales\/quote|POST sales\/:saleId\/resolve-review)/;
    const unwired = routes().filter((r) => /^(POST|PATCH|DELETE) (sales|sessions)/.test(r.key) && !r.idem && !NOT_MONEY.test(r.key)).map((r) => r.key);
    // Known, documented exceptions (5A): held-sale item edit is an absolute replace; force-close is now status-guarded (pos.session-close spec).
    expect(unwired.sort()).toEqual(['PATCH sales/:saleId/items', 'POST sessions/:sessionId/force-close'].sort());
  });
});
