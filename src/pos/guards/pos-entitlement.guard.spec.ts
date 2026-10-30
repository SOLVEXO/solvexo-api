/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PosEntitlementGuard, POS_PLAN_REQUIRED, POS_STORE_DISABLED } from './pos-entitlement.guard';

const OID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const lean = (v: any) => ({ select: () => ({ lean: () => Promise.resolve(v) }), sort: () => ({ select: () => ({ lean: () => Promise.resolve(v) }) }) });

function ctx(req: any) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}
function guardWith(repos: any) {
  return new PosEntitlementGuard({ repositories: repos } as any);
}
const futureDate = () => new Date(Date.now() + 86_400_000);
const pastDate = () => new Date(Date.now() - 86_400_000);

describe('PosEntitlementGuard', () => {
  const baseRepos = (over: any = {}) => ({
    storeModel: { findOne: jest.fn().mockReturnValue(lean({ status: 'active' })) },
    posPurchaseModel: { findOne: jest.fn().mockReturnValue(lean({ expiresAt: futureDate() })) },
    registerSessionModel: { findById: jest.fn().mockReturnValue(lean({ storeId: OID })) },
    saleModel: { findById: jest.fn().mockReturnValue(lean({ storeId: OID })) },
    ...over,
  });

  it('allows a store with an active plan (store id from the URL)', async () => {
    await expect(guardWith(baseRepos()).canActivate(ctx({ params: { storeId: OID } }))).resolves.toBe(true);
  });

  it('resolves the store from body, query, session id and sale id', async () => {
    const g = guardWith(baseRepos());
    await expect(g.canActivate(ctx({ params: {}, body: { storeId: OID } }))).resolves.toBe(true);
    await expect(g.canActivate(ctx({ params: {}, query: { storeId: OID } }))).resolves.toBe(true);
    await expect(g.canActivate(ctx({ params: { sessionId: OID } }))).resolves.toBe(true);
    await expect(g.canActivate(ctx({ params: { saleId: OID } }))).resolves.toBe(true);
  });

  it('blocks with POS_PLAN_REQUIRED when the store never bought a plan', async () => {
    const g = guardWith(baseRepos({ posPurchaseModel: { findOne: jest.fn().mockReturnValue(lean(null)) } }));
    await expect(g.canActivate(ctx({ params: { storeId: OID } }))).rejects.toMatchObject({ response: { code: POS_PLAN_REQUIRED } });
  });

  it('blocks with POS_PLAN_REQUIRED when the latest plan has expired', async () => {
    const g = guardWith(baseRepos({ posPurchaseModel: { findOne: jest.fn().mockReturnValue(lean({ expiresAt: pastDate() })) } }));
    await expect(g.canActivate(ctx({ params: { storeId: OID } }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['suspended', 'rejected'])('blocks a %s store even with an active plan', async (status) => {
    const g = guardWith(baseRepos({ storeModel: { findOne: jest.fn().mockReturnValue(lean({ status })) } }));
    await expect(g.canActivate(ctx({ params: { storeId: OID } }))).rejects.toMatchObject({ response: { code: POS_STORE_DISABLED } });
  });

  it('lets a pending (KYC under review) store trade if it has a plan', async () => {
    const g = guardWith(baseRepos({ storeModel: { findOne: jest.fn().mockReturnValue(lean({ status: 'pending' })) } }));
    await expect(g.canActivate(ctx({ params: { storeId: OID } }))).resolves.toBe(true);
  });

  it('blocks a store that does not exist', async () => {
    const g = guardWith(baseRepos({ storeModel: { findOne: jest.fn().mockReturnValue(lean(null)) } }));
    await expect(g.canActivate(ctx({ params: { storeId: OID } }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FAILS CLOSED when no store can be resolved (unlike the old billing guard)', async () => {
    await expect(guardWith(baseRepos()).canActivate(ctx({ params: {} }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when the session/sale id points at nothing', async () => {
    const g = guardWith(baseRepos({ registerSessionModel: { findById: jest.fn().mockReturnValue(lean(null)) } }));
    await expect(g.canActivate(ctx({ params: { sessionId: OID } }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-ObjectId store id instead of letting it reach a query', async () => {
    await expect(guardWith(baseRepos()).canActivate(ctx({ params: { storeId: '{"$ne":null}' } }))).rejects.toBeInstanceOf(BadRequestException);
  });
});
