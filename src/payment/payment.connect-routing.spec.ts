/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { isSellerOrderConnectSettled } from './payment.service';
import { stripCardMethodsIfNoProvider } from '../checkout/checkout.service';
import { DraftOrdersService } from '../draft-orders/draft-orders.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';

describe('isSellerOrderConnectSettled', () => {
  const connect = { storeId: 'store-A', accountId: 'acct_1' };

  it('is true only for an order paid through Stripe for the Connect-routed store', () => {
    expect(isSellerOrderConnectSettled(true, connect, 'store-A')).toBe(true);
  });

  it('REGRESSION: the COD (unpaid) physical part of a split checkout is NOT Connect-settled', () => {
    expect(isSellerOrderConnectSettled(false, connect, 'store-A')).toBe(false);
  });

  it('is false for another store or when there is no Connect routing at all', () => {
    expect(isSellerOrderConnectSettled(true, connect, 'store-B')).toBe(false);
    expect(isSellerOrderConnectSettled(true, null, 'store-A')).toBe(false);
    expect(isSellerOrderConnectSettled(true, undefined, 'store-A')).toBe(false);
  });
});

describe('stripCardMethodsIfNoProvider (Shopify: no payment provider → no card at checkout)', () => {
  it('keeps every method when the store has a card provider', () => {
    expect(stripCardMethodsIfNoProvider(['stripe', 'split', 'cash_on_delivery', 'manual_bank_transfer'], true))
      .toEqual(['stripe', 'split', 'cash_on_delivery', 'manual_bank_transfer']);
  });

  it('REGRESSION: drops card and split-card but keeps COD / bank transfer when there is no provider', () => {
    expect(stripCardMethodsIfNoProvider(['stripe', 'split', 'cash_on_delivery', 'manual_bank_transfer'], false))
      .toEqual(['cash_on_delivery', 'manual_bank_transfer']);
  });

  it('can legitimately end up with no methods (a digital store with no provider) — it is NOT silently re-added', () => {
    expect(stripCardMethodsIfNoProvider(['stripe'], false)).toEqual([]);
  });
});

describe('DraftOrdersService.createInvoicePaymentIntent — pays the seller, never the platform account', () => {
  function setup(connect: string | null) {
    const draft = { _id: 'd1', storeId: 'store-A', status: 'open', isPaid: false, total: 50, currency: 'USD' };
    const db = { repositories: { draftOrderModel: { findOne: jest.fn().mockResolvedValue(draft) } } } as any;
    const stripeConnect = { getEligibleConnectAccountForStore: jest.fn().mockResolvedValue(connect) };
    const commission = { cardApplicationFeeCents: jest.fn().mockResolvedValue(175) };
    const service = new DraftOrdersService(
      db, { log: jest.fn() } as any, {} as any, {} as any, { get: jest.fn().mockReturnValue('sk_test_dummy') } as any,
      stripeConnect as any, commission as any, { notify: jest.fn() } as any,
    );
    const create = jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'cs_1' });
    (service as any).stripe.paymentIntents.create = create;
    return { service, create };
  }

  it('creates a destination charge to the seller with the pass-through fee', async () => {
    const { service, create } = setup('acct_seller');
    const res = await service.createInvoicePaymentIntent('tok');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 5000, transfer_data: { destination: 'acct_seller' }, application_fee_amount: 175,
      metadata: expect.objectContaining({ settledViaConnect: 'true', connectedAccountId: 'acct_seller' }),
    }));
    expect(res.clientSecret).toBe('cs_1');
  });

  it('REGRESSION: with no connected account it refuses (previously it silently charged the platform account)', async () => {
    const { service, create } = setup(null);
    await expect(service.createInvoicePaymentIntent('tok')).rejects.toThrow(/hasn't set up online card payments/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('GiftCardsService.createPurchaseIntent — gift-card money goes to the seller', () => {
  function setup(connect: string | null) {
    const store = { _id: 'store-A', baseCurrency: 'USD', status: 'active', isDelete: false };
    const r = {
      storeModel: { findOne: jest.fn().mockResolvedValue(store) },
      giftCardSettingsModel: { findOne: jest.fn().mockResolvedValue({ purchaseEnabled: true }), create: jest.fn() },
    };
    const db = { repositories: r } as any;
    const stripeConnect = { getEligibleConnectAccountForStore: jest.fn().mockResolvedValue(connect) };
    const commission = { cardApplicationFeeCents: jest.fn().mockResolvedValue(145) };
    const service = new GiftCardsService(
      db, { log: jest.fn() } as any, { assertSupportedCurrency: jest.fn().mockResolvedValue(undefined) } as any, {} as any,
      { get: jest.fn().mockReturnValue('sk_test_dummy') } as any, stripeConnect as any, commission as any,
    );
    jest.spyOn(service as any, 'getOrCreateSettings').mockResolvedValue({ purchaseEnabled: true });
    const create = jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'cs_1' });
    (service as any).stripe.paymentIntents.create = create;
    return { service, create };
  }

  it('creates a destination charge to the seller (they were previously never credited for gift-card sales)', async () => {
    const { service, create } = setup('acct_seller');
    await service.createPurchaseIntent('buyer-1', 'store-A', { amount: 25 } as any);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      amount: 2500, transfer_data: { destination: 'acct_seller' }, application_fee_amount: 145,
      metadata: expect.objectContaining({ purpose: 'gift_card_purchase', connectedAccountId: 'acct_seller' }),
    }));
  });

  it('REGRESSION: a store with no connected account cannot sell gift cards by card', async () => {
    const { service, create } = setup(null);
    await expect(service.createPurchaseIntent('buyer-1', 'store-A', { amount: 25 } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});
