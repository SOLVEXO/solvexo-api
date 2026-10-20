/* eslint-disable prettier/prettier */
import { ReviewRequestsService } from './review-requests.service';

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

/** Plain fakes (no jest API). `outcome` is what the email send reports. */
function setup(opts: { orders: any[]; user?: any; reviewedProductIds?: string[] }) {
  const sent: any[] = [];
  const marked: string[] = [];
  const repos: any = {
    orderModel: {
      find: () => ({ select: () => ({ limit: () => ({ lean: async () => opts.orders }) }) }),
      updateOne: async (q: any) => { marked.push(String(q._id)); return {}; },
    },
    userModel: { findById: () => ({ select: () => ({ lean: async () => (opts.user === undefined ? { name: 'Ayesha', email: 'a@x.com', isGuest: false } : opts.user) }) }) },
    ratingModel: { find: () => ({ select: () => ({ lean: async () => (opts.reviewedProductIds ?? []).map((productId) => ({ productId })) }) }) },
    storeModel: { findById: () => ({ select: () => ({ lean: async () => ({ slug: 'amara' }) }) }) },
  };
  const notifications: any = { sendCustomerEmail: async (args: any) => { sent.push(args); return 'sent'; } };
  const svc = new ReviewRequestsService({ repositories: repos } as any, {} as any, notifications);
  return { svc, sent, marked };
}

const order = (over: any = {}) => ({
  _id: 'O1', orderNumber: 'ORD-1', userId: 'U1',
  sellerOrders: [{ storeId: 'S1', status: 'delivered', deliveredAt: daysAgo(4), items: [{ productId: 'P1', name: 'Tee', status: 'delivered' }, { productId: 'P2', name: 'Mug', status: 'cancelled' }] }],
  ...over,
});

describe('ReviewRequestsService', () => {
  it('asks for a review of the delivered, not-cancelled items and marks the order once', async () => {
    const { svc, sent, marked } = setup({ orders: [order()] });
    const n = await svc.sendDueRequests(NOW);
    expect(n).toBe(1);
    expect(sent.length).toBe(1);
    expect(sent[0].event).toBe('review_request');
    expect(sent[0].to).toBe('a@x.com');
    expect(sent[0].vars.itemList).toBe('• Tee');
    expect(sent[0].vars.reviewUrl).toContain('/orders/O1');
    expect(marked).toEqual(['O1']);
  });

  it('skips products the buyer already reviewed (the order is still marked)', async () => {
    const { svc, sent, marked } = setup({ orders: [order()], reviewedProductIds: ['P1'] });
    await svc.sendDueRequests(NOW);
    expect(sent.length).toBe(0);
    expect(marked).toEqual(['O1']);
  });

  it('never emails a guest checkout', async () => {
    const { svc, sent, marked } = setup({ orders: [order()], user: { name: 'G', email: 'g@x.com', isGuest: true } });
    await svc.sendDueRequests(NOW);
    expect(sent.length).toBe(0);
    expect(marked).toEqual(['O1']);
  });

  it('one email per store of a multi-store order, only for stores delivered inside the window', async () => {
    const two = order({
      sellerOrders: [
        { storeId: 'S1', status: 'delivered', deliveredAt: daysAgo(4), items: [{ productId: 'P1', name: 'Tee', status: 'delivered' }] },
        { storeId: 'S2', status: 'delivered', deliveredAt: daysAgo(1), items: [{ productId: 'P3', name: 'Cap', status: 'delivered' }] },
        { storeId: 'S3', status: 'delivered', deliveredAt: daysAgo(4), items: [{ productId: 'P4', name: 'Hat', status: 'delivered' }] },
      ],
    });
    const { svc, sent } = setup({ orders: [two] });
    await svc.sendDueRequests(NOW);
    expect(sent.map((s) => s.storeId)).toEqual(['S1', 'S3']);
  });
});
