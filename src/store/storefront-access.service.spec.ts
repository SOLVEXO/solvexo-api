import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { StorefrontAccessService } from './storefront-access.service';

function make(privacyMode: string) {
  const lean = (v: any) => ({ select: () => ({ lean: async () => v }) });
  const db: any = {
    repositories: {
      storeModel: { findOne: jest.fn(() => lean({ privacyMode, sellerId: 'sel1' })) },
      productModel: { findById: jest.fn(() => lean({ storeId: 's1' })) },
      productVariantModel: { findById: jest.fn(() => lean({ productId: 'p1' })) },
    },
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  return { svc: new StorefrontAccessService(db, jwt), jwt, db };
}
const req = (path: string, headers: any = {}, query: any = {}) => ({ method: 'GET', path, headers, query });

describe('StorefrontAccessService', () => {
  it('lets every request through for a non-password store', async () => {
    const { svc } = make('public');
    await expect(svc.assertAccess(req('/api/public/collections/s1'))).resolves.toBeUndefined();
  });

  it('ignores routes that are not gated (store basic info, verify route)', async () => {
    const { svc, db } = make('password');
    await svc.assertAccess(req('/api/store/public/my-slug'));
    await svc.assertAccess({ method: 'POST', path: '/api/store/s1/storefront-password/verify', headers: {} });
    expect(db.repositories.storeModel.findOne).not.toHaveBeenCalled();
  });

  it('blocks gated routes of a password store without a token', async () => {
    const { svc } = make('password');
    for (const p of ['/api/public/collections/s1', '/api/public/store-theme/s1', '/api/store/public/s1/products', '/api/products/getProductById/p1', '/api/products/getVariantById/v1']) {
      await expect(svc.assertAccess(req(p))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('accepts a valid token for that store only, and rejects wrong-store / wrong-type / garbage tokens', async () => {
    const { svc, jwt } = make('password');
    const ok = svc.signToken('s1');
    await expect(svc.assertAccess(req('/api/public/store-pages/s1/home', { 'x-storefront-token': ok }))).resolves.toBeUndefined();
    await expect(svc.assertAccess(req('/api/public/store-pages/s2/home', { 'x-storefront-token': ok }))).rejects.toBeInstanceOf(ForbiddenException);
    const wrongType = jwt.sign({ type: 'access', storeId: 's1' });
    await expect(svc.assertAccess(req('/api/public/store-pages/s1/home', { 'x-storefront-token': wrongType }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.assertAccess(req('/api/public/store-pages/s1/home', { 'x-storefront-token': 'junk' }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolves cart/checkout store from query or the JWT storeId', async () => {
    const { svc, jwt } = make('password');
    await expect(svc.assertAccess(req('/api/cart/get-cart', {}, { storeId: 's1' }))).rejects.toBeInstanceOf(ForbiddenException);
    const buyer = jwt.sign({ sub: 'u1', role: 'user', storeId: 's1' });
    await expect(svc.assertAccess(req('/api/checkout/create-checkout', { authorization: `Bearer ${buyer}` }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the owning seller, own-store staff and admin through, not another seller or another store\'s staff', async () => {
    const { svc, jwt } = make('password');
    const call = (claims: any) => svc.assertAccess(req('/api/public/collections/s1', { authorization: `Bearer ${jwt.sign(claims)}` }));
    await expect(call({ sub: 'sel1', role: 'seller' })).resolves.toBeUndefined();
    await expect(call({ sub: 'st1', role: 'staff', storeId: 's1' })).resolves.toBeUndefined();
    await expect(call({ sub: 'a1', role: 'admin' })).resolves.toBeUndefined();
    await expect(call({ sub: 'sel2', role: 'seller' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call({ sub: 'st2', role: 'staff', storeId: 's2' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gates legacy/global buyers that send storeId only in the JSON body, and payment routes by checkoutId', async () => {
    const { svc, db } = make('password');
    await expect(svc.assertAccess({ method: 'POST', path: '/api/cart/add-to-cart', headers: {}, query: {}, body: { storeId: 's1' } })).rejects.toBeInstanceOf(ForbiddenException);
    db.repositories.checkoutModel = { findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ items: [{ storeId: 's1' }] }) }) })) };
    await expect(svc.assertAccess({ method: 'POST', path: '/api/payment/cod-payment', headers: {}, query: {}, body: { checkoutId: 'c1' } })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('gates /api/search/products only when a storeId is given', async () => {
    const { svc, db } = make('password');
    await svc.assertAccess(req('/api/search/products', {}, {}));
    expect(db.repositories.storeModel.findOne).not.toHaveBeenCalled();
    await expect(svc.assertAccess(req('/api/search/products', {}, { storeId: 's1' }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('coming_soon: 403 with reason, a storefront token does not unlock it, owner/staff/admin still pass', async () => {
    const { svc, jwt } = make('coming_soon');
    const token = svc.signToken('s1');
    const err: any = await svc.assertAccess(req('/api/public/collections/s1', { 'x-storefront-token': token })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ storefrontLocked: true, reason: 'coming_soon' });
    const call = (claims: any) => svc.assertAccess(req('/api/public/collections/s1', { authorization: 'Bearer ' + jwt.sign(claims) }));
    await expect(call({ sub: 'sel1', role: 'seller' })).resolves.toBeUndefined();
    await expect(call({ sub: 'st1', role: 'staff', storeId: 's1' })).resolves.toBeUndefined();
    await expect(call({ sub: 'a1', role: 'admin' })).resolves.toBeUndefined();
  });
});
