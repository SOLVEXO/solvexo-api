/* eslint-disable prettier/prettier */
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { AUDIT_STORE_META, StoreWriteAuditInterceptor } from './audit-store-writes';

const STORE = '6ac5cae50f9f63df82763e4f';

function setup(req: any, meta: any = { resource: 'theme', category: 'settings' }) {
  const activity = { log: jest.fn().mockResolvedValue(undefined) };
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: any) => (key === AUDIT_STORE_META ? meta : undefined));
  const interceptor = new StoreWriteAuditInterceptor(activity as any, reflector);
  const ctx: any = { getType: () => 'http', getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) };
  const run = (result: any = { ok: true }) => new Promise<void>((resolve) => interceptor.intercept(ctx, { handle: () => of(result) } as any).subscribe({ complete: () => resolve() }));
  return { activity, run };
}

describe('StoreWriteAuditInterceptor', () => {
  it('logs a successful seller change with field NAMES only — never secret values', async () => {
    const { activity, run } = setup({ method: 'PATCH', route: { path: '/api/x/:storeId/:id' }, params: { storeId: STORE, id: 'abc' }, body: { name: 'N', apiKey: 'SECRET', password: 'P' }, user: { role: 'seller', userId: 'u1' }, headers: {}, ip: '1.1.1.1' });
    await run();
    const entry = activity.log.mock.calls[0][0];
    expect(entry).toMatchObject({ storeId: STORE, category: 'settings', action: 'theme_updated', actorId: 'u1', targetId: 'abc', targetType: 'theme' });
    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(entry.metadata.fields).toEqual(['name']);
    expect(entry.description).toContain('credentials');
  });

  it('maps a route action word to a verb and reads import counts from the response', async () => {
    const pub = setup({ method: 'POST', route: { path: '/api/x/:storeId/:pageId/publish' }, params: { storeId: STORE, pageId: 'p' }, body: {}, user: { role: 'staff', userId: 's1' }, headers: {} });
    await pub.run();
    expect(pub.activity.log.mock.calls[0][0].action).toBe('theme_published');

    const imp = setup({ method: 'POST', route: { path: '/api/x/:storeId/import' }, params: { storeId: STORE }, body: {}, user: { role: 'seller', userId: 'u1' }, headers: {} }, { resource: 'product', category: 'products' });
    await imp.run({ success: true, data: { created: 5, updated: 1, skipped: 2, failedCount: 0 } });
    const e = imp.activity.log.mock.calls[0][0];
    expect(e.action).toBe('product_imported');
    expect(e.description).toContain('5 created, 1 updated, 2 skipped, 0 failed');
  });

  it('ignores reads, admins, buyers and requests without a valid store id', async () => {
    for (const req of [
      { method: 'GET', params: { storeId: STORE }, user: { role: 'seller', userId: 'u' } },
      { method: 'POST', params: { storeId: STORE }, user: { role: 'admin', userId: 'a' } },
      { method: 'POST', params: { storeId: STORE } },
      { method: 'POST', params: { storeId: 'not-an-id' }, user: { role: 'seller', userId: 'u' } },
    ]) {
      const { activity, run } = setup({ route: { path: '/x' }, body: {}, headers: {}, ...req });
      await run();
      expect(activity.log).not.toHaveBeenCalled();
    }
  });
});
