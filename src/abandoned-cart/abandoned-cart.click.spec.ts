import { AbandonedCartService } from './abandoned-cart.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** The recovery link must land the buyer on the STORE's own cart, never on the platform marketing site. */
function setup(checkout: any | null, stores: any[]) {
  const checkoutModel = new FakeModel();
  if (checkout) checkoutModel.rows.push(checkout);
  const storeModel = new FakeModel();
  storeModel.rows.push(...stores);
  const db: any = { repositories: { checkoutModel, storeModel } };
  const svc = new AbandonedCartService(db, { log: () => undefined } as any, {} as any, {} as any);
  return { svc, checkoutModel };
}

const checkout = { _id: 'c1', abandonedRecoveryToken: 'tok', abandonedClickedAt: null, items: [{ storeId: 's1' }, { storeId: 's2' }] };
const shop = { _id: 's1', isDelete: false, slug: 'shop-one', customDomain: null };
const other = { _id: 's2', isDelete: false, slug: 'shop-two', customDomain: 'www.two.example', customDomainStatus: 'verified' };

describe('abandoned cart recovery link', () => {
  it('goes to the cart of the store named in the link, when it is one of the checkout\'s stores', async () => {
    const { svc } = setup(checkout, [shop, other]);
    expect(await svc.trackClick('tok', 's2')).toBe('https://www.two.example/cart');
  });

  it('uses the store subdomain when there is no verified custom domain', async () => {
    const { svc } = setup(checkout, [shop, other]);
    expect(await svc.trackClick('tok', 's1')).toBe('https://shop-one.solvexo.store/cart');
  });

  it('ignores a store id that is not in the checkout and falls back to its first store', async () => {
    const { svc } = setup(checkout, [shop, other, { _id: 's9', isDelete: false, slug: 'someone-else', customDomain: null }]);
    expect(await svc.trackClick('tok', 's9')).toBe('https://shop-one.solvexo.store/cart');
  });

  it('records the click once', async () => {
    const { svc, checkoutModel } = setup({ ...checkout }, [shop]);
    await svc.trackClick('tok', 's1');
    expect(!!checkoutModel.rows[0].abandonedClickedAt).toBe(true);
  });

  it('an unknown link returns null so the caller can fall back', async () => {
    const { svc } = setup(null, [shop]);
    expect(await svc.trackClick('nope', 's1')).toBeNull();
  });
});
