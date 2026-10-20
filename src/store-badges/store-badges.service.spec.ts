/* eslint-disable prettier/prettier */
import { StoreBadgesService } from './store-badges.service';

/** Plain fakes (no jest API) so the file also runs under a tiny runner. */
function makeService(counts: Partial<Record<string, number | 'throw'>>) {
  const count = (key: string) => async () => {
    const v = counts[key];
    if (v === 'throw') throw new Error('boom');
    return v ?? 0;
  };
  const repos: any = {
    storeModel: { findById: async () => ({ isDelete: false, sellerId: { toString: () => 'seller-1' }, lowStockThreshold: 5 }) },
    orderModel: { countDocuments: count('returns') },
    paymentTransactionModel: { countDocuments: count('disputes') },
    manualPaymentProofModel: { countDocuments: count('payment-proofs') },
    conversationModel: { countDocuments: count('messages') },
    storeContactMessageModel: { countDocuments: count('online-store-contact') },
    ratingModel: { countDocuments: count('reviews') },
    productVariantModel: { aggregate: async () => { const v = counts['inventory']; if (v === 'throw') throw new Error('boom'); return v ? [{ n: v }] : []; } },
  };
  return new StoreBadgesService({ repositories: repos } as any);
}

describe('StoreBadgesService', () => {
  it('a seller gets every non-zero count and zero counts are left out', async () => {
    const svc = makeService({ returns: 3, disputes: 0, 'payment-proofs': 2, messages: 7, inventory: 4 });
    const res = await svc.get({ role: 'seller' }, 'seller-1', 'store-1');
    expect(res.data).toEqual({ returns: 3, 'payment-proofs': 2, messages: 7, inventory: 4 });
  });

  it('a staff member only gets the areas their role may open', async () => {
    const svc = makeService({ returns: 3, disputes: 5, messages: 7, inventory: 4 });
    const res = await svc.get({ role: 'staff', permissions: ['messaging.view', 'inventory.view'] }, 'seller-1', 'store-1');
    expect(res.data).toEqual({ messages: 7, inventory: 4 });
  });

  it('one failing count never breaks the others', async () => {
    const svc = makeService({ returns: 'throw', messages: 2 });
    const res = await svc.get({ role: 'seller' }, 'seller-1', 'store-1');
    expect(res.data).toEqual({ messages: 2 });
  });

  it('refuses a store that belongs to someone else', async () => {
    const svc = makeService({ messages: 2 });
    let failed = false;
    try { await svc.get({ role: 'seller' }, 'other-seller', 'store-1'); } catch { failed = true; }
    expect(failed).toBe(true);
  });
});
