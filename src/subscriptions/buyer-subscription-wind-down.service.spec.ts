/* eslint-disable prettier/prettier */
import { BuyerSubscriptionWindDownService, WIND_DOWN_REASON } from './buyer-subscription-wind-down.service';

const NOW = new Date('2026-10-10T12:00:00Z');
const FUTURE = new Date('2026-10-25T00:00:00Z');
const PAST = new Date('2026-10-01T00:00:00Z');

function sub(over: Record<string, any> = {}) {
  return {
    _id: 'sub-1', planId: 'plan-1', customerId: 'buyer-1', storeId: 'store-1',
    status: 'active', currentPeriodEnd: FUTURE, canceledAt: null, cancellationReason: null,
    providerSubscriptionId: 'sub_stripe_1',
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function setup(subs: any[], opts: { stripeError?: boolean } = {}) {
  const find = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(subs) });
  const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });
  const db = {
    repositories: {
      subscriptionModel: { find, updateMany },
      subscriptionPlanModel: { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ name: 'VIP Gold' }) }) }) },
    },
  } as any;
  const gateway = {
    scheduleProviderCancellation: jest.fn().mockImplementation(async () => { if (opts.stripeError) throw new Error('Stripe down'); }),
    cancelProviderSubscription: jest.fn().mockResolvedValue(undefined),
  };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const activity = { log: jest.fn() };
  const service = new BuyerSubscriptionWindDownService(db, gateway as any, notifications as any, activity as any);
  return { service, find, updateMany, gateway, notifications, activity };
}

describe('BuyerSubscriptionWindDownService — retiring the removed VIP plans without cutting anyone off', () => {
  it('a paid-up Stripe subscription is set to END with its current period (no further charge) and stays active until then', async () => {
    const s = sub();
    const { service, gateway, notifications } = setup([s]);

    const r = await service.windDown(NOW);

    expect(gateway.scheduleProviderCancellation).toHaveBeenCalledWith('sub_stripe_1');
    expect(gateway.cancelProviderSubscription).not.toHaveBeenCalled();
    expect(s.status).toBe('active'); // the buyer keeps what they already paid for
    expect(s.canceledAt).toEqual(NOW);
    expect(s.cancellationReason).toBe(WIND_DOWN_REASON);
    expect(s.save).toHaveBeenCalled();
    expect(r).toMatchObject({ scheduledToEnd: 1, cancelledNow: 0, failed: 0 });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 'buyer-1', body: expect.stringContaining('2026-10-25'),
    }));
  });

  it('an unpaid (past_due) subscription is cancelled immediately — there is nothing to honour', async () => {
    const s = sub({ status: 'past_due' });
    const { service, gateway } = setup([s]);

    const r = await service.windDown(NOW);

    expect(gateway.cancelProviderSubscription).toHaveBeenCalledWith('sub_stripe_1');
    expect(gateway.scheduleProviderCancellation).not.toHaveBeenCalled();
    expect(s.status).toBe('canceled');
    expect(r.cancelledNow).toBe(1);
  });

  it('a paused subscription is cancelled immediately', async () => {
    const s = sub({ status: 'paused' });
    const { service } = setup([s]);
    await service.windDown(NOW);
    expect(s.status).toBe('canceled');
  });

  it('a subscription whose paid period already ended is cancelled now rather than scheduled', async () => {
    const s = sub({ currentPeriodEnd: PAST });
    const { service, gateway } = setup([s]);
    await service.windDown(NOW);
    expect(gateway.cancelProviderSubscription).toHaveBeenCalled();
    expect(s.status).toBe('canceled');
  });

  it('a non-Stripe (manual provider) subscription makes no Stripe call at all', async () => {
    const s = sub({ providerSubscriptionId: null });
    const { service, gateway } = setup([s]);
    await service.windDown(NOW);
    expect(gateway.scheduleProviderCancellation).not.toHaveBeenCalled();
    expect(gateway.cancelProviderSubscription).not.toHaveBeenCalled();
    expect(s.canceledAt).toEqual(NOW);
  });

  it('only picks up subscriptions NOT already wound down (idempotent), and never deleted ones', async () => {
    const { service, find } = setup([]);
    await service.windDown(NOW);
    expect(find).toHaveBeenCalledWith({ status: { $in: ['active', 'paused', 'past_due'] }, canceledAt: null, isDelete: false });
  });

  it('REGRESSION: if Stripe fails, the local row is NOT marked and the buyer is NOT told (so the next run retries)', async () => {
    const s = sub();
    const { service, notifications } = setup([s], { stripeError: true });

    const r = await service.windDown(NOW);

    expect(r.failed).toBe(1);
    expect(s.save).not.toHaveBeenCalled();
    expect(s.canceledAt).toBeNull();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('marks wound-down subscriptions whose paid period has ended as canceled', async () => {
    const { service, updateMany } = setup([]);

    const r = await service.windDown(NOW);

    expect(updateMany).toHaveBeenCalledWith(
      { status: 'active', cancellationReason: WIND_DOWN_REASON, canceledAt: { $ne: null }, currentPeriodEnd: { $lte: NOW } },
      { $set: { status: 'canceled' } },
    );
    expect(r.finalized).toBe(2);
  });

  it('does not touch history: nothing is deleted, only flagged', async () => {
    const s = sub();
    const { service } = setup([s]);
    await service.windDown(NOW);
    expect(s).not.toHaveProperty('isDelete', true);
  });
});
