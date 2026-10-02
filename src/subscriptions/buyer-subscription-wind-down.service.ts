/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { ActivityLogService } from '../activity-log/activity-log.service';

export const WIND_DOWN_REASON = 'vip_plans_discontinued';

/**
 * The buyer-facing "VIP / membership plans" feature was REMOVED (Shopify has no such core
 * feature). Buyers who were already subscribed are wound down gracefully — nobody is cut off
 * mid-period or charged again:
 *
 *  1. A subscription that is paid up and running is told to stop at the END of its current
 *     paid period (Stripe `cancel_at_period_end`) and the buyer is notified once.
 *  2. A subscription that was never paid up (past_due) or is paused is cancelled right away —
 *     there is nothing to honour.
 *  3. Once a wound-down subscription's period has ended it is marked `canceled`.
 *
 * Idempotent and safe to run repeatedly (daily cron + admin trigger). The historical rows
 * (plans, subscriptions, invoices, credit wallets) are KEPT, only hidden — nothing is deleted.
 * Once no live subscription is left this does nothing and can itself be removed.
 */
@Injectable()
export class BuyerSubscriptionWindDownService {
  private readonly logger = new Logger(BuyerSubscriptionWindDownService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly notifications: NotificationsService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get subModel() { return this.db.repositories.subscriptionModel; }
  private get planModel() { return this.db.repositories.subscriptionPlanModel; }

  async windDown(now = new Date(), batchSize = 200) {
    const result = { scheduledToEnd: 0, cancelledNow: 0, finalized: 0, failed: 0 };

    // 1 + 2: anything not yet touched
    const pending: any[] = await this.subModel
      .find({ status: { $in: ['active', 'paused', 'past_due'] }, canceledAt: null, isDelete: false })
      .limit(batchSize);

    for (const sub of pending) {
      try {
        const runningAndPaid = sub.status === 'active' && sub.currentPeriodEnd > now;
        if (sub.providerSubscriptionId) {
          if (runningAndPaid) await this.gateway.scheduleProviderCancellation(sub.providerSubscriptionId);
          else await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
        }

        sub.canceledAt = now;
        sub.cancellationReason = WIND_DOWN_REASON;
        if (runningAndPaid) {
          result.scheduledToEnd++;
        } else {
          sub.status = 'canceled';
          result.cancelledNow++;
        }
        await sub.save();

        await this.notifyBuyer(sub, runningAndPaid);
        this.activityLogService.log({
          storeId: sub.storeId, category: 'subscriptions', action: 'vip_plan_wound_down',
          description: runningAndPaid
            ? `Membership plans were discontinued — subscription will end ${sub.currentPeriodEnd.toISOString().slice(0, 10)} with no further charges`
            : 'Membership plans were discontinued — unpaid/paused subscription cancelled',
          actorRole: 'system', targetId: String(sub._id), targetType: 'subscription',
        });
      } catch (err: any) {
        result.failed++;
        this.logger.error(`Wind-down failed for subscription ${sub._id}: ${err?.message}`);
      }
    }

    // 3: wound-down subscriptions whose paid period has now ended
    const ended = await this.subModel.updateMany(
      { status: 'active', cancellationReason: WIND_DOWN_REASON, canceledAt: { $ne: null }, currentPeriodEnd: { $lte: now } },
      { $set: { status: 'canceled' } },
    );
    result.finalized = (ended as any).modifiedCount ?? 0;

    return result;
  }

  private async notifyBuyer(sub: any, runningAndPaid: boolean) {
    const plan: any = await this.planModel.findById(sub.planId).select('name').lean();
    const name = plan?.name ?? 'your membership';
    const endsOn = sub.currentPeriodEnd.toISOString().slice(0, 10);
    await this.notifications.notify({
      recipientId: sub.customerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.SUBSCRIPTION_CANCELLED,
      title: 'Membership plans are being discontinued',
      body: runningAndPaid
        ? `"${name}" will stay active until ${endsOn} and then end. You won't be charged again.`
        : `"${name}" has been cancelled. You won't be charged again.`,
      data: { subscriptionId: String(sub._id), storeId: sub.storeId },
    }).catch(() => undefined);
  }
}
