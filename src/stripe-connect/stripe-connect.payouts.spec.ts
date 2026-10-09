/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StripeConnectService } from './stripe-connect.service';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';
const ACCOUNT = 'acct_123';

function makeService(storeDoc: any = { stripeConnectedAccountId: ACCOUNT }) {
  const storeModel = { findOne: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(storeDoc) }) };
  const db: any = { repositories: { storeModel } };
  const config: any = { get: jest.fn().mockReturnValue('sk_test_abc') };
  const service = new StripeConnectService(db, { log: jest.fn() } as any, config);
  const stripe: any = {
    payouts: { retrieve: jest.fn() },
    balanceTransactions: { list: jest.fn() },
  };
  (service as any).stripe = stripe;
  return { service, stripe };
}

const txn = (over: Record<string, any> = {}) => ({
  id: 'txn_1', type: 'charge', description: 'Order 1', amount: 10000, fee: 320, net: 9680, currency: 'pkr',
  created: 1_760_000_000, available_on: 1_760_600_000, status: 'available', source: 'ch_1', ...over,
});

describe('StripeConnectService — payout detail & balance transactions', () => {
  it('payout detail reads from the store\'s connected account and totals per currency', async () => {
    const { service, stripe } = makeService();
    stripe.payouts.retrieve.mockResolvedValue({ id: 'po_1', amount: 19360, currency: 'pkr', status: 'paid', method: 'standard', arrival_date: 1_760_600_000, created: 1_760_000_000 });
    stripe.balanceTransactions.list.mockResolvedValue({ data: [txn(), txn({ id: 'txn_2' })], has_more: false });

    const res = await service.getPayoutDetail(SELLER_ID, STORE_ID, 'po_1');

    expect(stripe.payouts.retrieve).toHaveBeenCalledWith('po_1', {}, { stripeAccount: ACCOUNT });
    expect(stripe.balanceTransactions.list).toHaveBeenCalledWith({ payout: 'po_1', limit: 100 }, { stripeAccount: ACCOUNT });
    expect(res.data.payout.amount).toBe(193.6);
    expect(res.data.transactions).toHaveLength(2);
    expect(res.data.totals).toEqual([{ currency: 'PKR', gross: 200, fees: 6.4, net: 193.6 }]);
  });

  it('rejects a malformed payout id before calling Stripe', async () => {
    const { service, stripe } = makeService();
    await expect(service.getPayoutDetail(SELLER_ID, STORE_ID, 'po_1/../x')).rejects.toThrow(BadRequestException);
    expect(stripe.payouts.retrieve).not.toHaveBeenCalled();
  });

  it('a payout that is not on this store\'s account is "not found" (Stripe resource_missing)', async () => {
    const { service, stripe } = makeService();
    stripe.payouts.retrieve.mockRejectedValue({ code: 'resource_missing', statusCode: 404 });
    await expect(service.getPayoutDetail(SELLER_ID, STORE_ID, 'po_other')).rejects.toThrow('Payout not found');
  });

  it('refuses a store that does not belong to the seller', async () => {
    const { service } = makeService(null);
    await expect(service.getPayoutDetail(SELLER_ID, STORE_ID, 'po_1')).rejects.toThrow(ForbiddenException);
  });

  it('refuses when the store has no Stripe account yet', async () => {
    const { service } = makeService({ stripeConnectedAccountId: null });
    await expect(service.getBalanceTransactions(SELLER_ID, STORE_ID)).rejects.toThrow(BadRequestException);
  });

  it('Connect not enabled on the platform Stripe account → a friendly error for the seller, not Stripe\'s raw message', async () => {
    const { service, stripe } = makeService({ _id: STORE_ID, stripeConnectedAccountId: null, name: 'S' });
    (service as any).r.sellerModel = { findById: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ email: 'a@b.c' }) }) };
    stripe.accounts = { create: jest.fn().mockRejectedValue(new Error("You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.")) };

    await expect((service as any).getOrCreateAccount(SELLER_ID, { _id: STORE_ID, stripeConnectedAccountId: null }))
      .rejects.toThrow('Online card payments are not available yet on this platform');
  });

  it('balance transactions are cursor-paged and clamp the page size', async () => {
    const { service, stripe } = makeService();
    stripe.balanceTransactions.list.mockResolvedValue({ data: [txn({ id: 'txn_a' }), txn({ id: 'txn_b' })], has_more: true });

    const res = await service.getBalanceTransactions(SELLER_ID, STORE_ID, { limit: 5000, startingAfter: 'txn_prev' });

    expect(stripe.balanceTransactions.list).toHaveBeenCalledWith({ limit: 100, starting_after: 'txn_prev' }, { stripeAccount: ACCOUNT });
    expect(res.data.nextCursor).toBe('txn_b');
    expect(res.data.hasMore).toBe(true);
  });

  it('rejects a bad cursor or type instead of forwarding it to Stripe', async () => {
    const { service, stripe } = makeService();
    await expect(service.getBalanceTransactions(SELLER_ID, STORE_ID, { startingAfter: 'x; drop' })).rejects.toThrow(BadRequestException);
    await expect(service.getBalanceTransactions(SELLER_ID, STORE_ID, { type: 'Charge!' })).rejects.toThrow(BadRequestException);
    expect(stripe.balanceTransactions.list).not.toHaveBeenCalled();
  });
});
