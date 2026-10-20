/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '@/database/databaseservice';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { storePublicUrl } from '@/newsletter/marketing-email.util';

/** Days after delivery before the "how was your order?" email goes out. */
export const REVIEW_REQUEST_DELAY_DAYS = 3;
/** Orders delivered longer ago than this are never asked (stops a burst of old orders when a store switches it on). */
export const REVIEW_REQUEST_MAX_AGE_DAYS = 10;
const DAY = 24 * 3600 * 1000;
const DELIVERED = ['delivered', 'completed'];

/**
 * "Review request" customer email: a few days after an order is delivered, ask the buyer to review what they bought
 * (Shopify review apps such as Judge.me / Loox do the same). The email is a normal catalog event
 * (`review_request`), so each store switches it on/off and edits its text under Settings → Notifications. It is OFF
 * until the seller enables it. One attempt per order (`Order.reviewRequestSentAt`); guest checkouts and products the
 * buyer already reviewed are skipped.
 */
@Injectable()
export class ReviewRequestsService {
  private readonly logger = new Logger(ReviewRequestsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Hourly (minute 25). Needs Redis for the single-instance lock, like every other cron. */
  @Cron('25 * * * *')
  async cron() {
    const result = await this.redis.withLock('cron-lock:review-requests', 20 * 60_000, async () => {
      const n = await this.sendDueRequests();
      if (n > 0) this.logger.log(`Review requests handled for ${n} order(s)`);
    });
    if (result === 'lock_not_acquired') this.logger.debug('Skipped review requests: another instance holds the lock (or Redis is unavailable)');
  }

  /** Handles up to `limit` due orders; returns how many were processed (sent, switched off or skipped). */
  async sendDueRequests(now: Date = new Date(), limit = 200): Promise<number> {
    const { orderModel, userModel, ratingModel, storeModel } = this.db.repositories;
    const from = new Date(now.getTime() - REVIEW_REQUEST_MAX_AGE_DAYS * DAY);
    const to = new Date(now.getTime() - REVIEW_REQUEST_DELAY_DAYS * DAY);

    const orders: any[] = await orderModel
      .find({
        isDelete: false,
        reviewRequestSentAt: null,
        sellerOrders: { $elemMatch: { status: { $in: DELIVERED }, deliveredAt: { $gte: from, $lte: to } } },
      })
      .select('orderNumber userId sellerOrders')
      .limit(limit)
      .lean();

    let handled = 0;
    for (const order of orders) {
      try {
        await this.handleOrder(order, { from, to, userModel, ratingModel, storeModel });
      } catch (err: any) {
        this.logger.warn(`Review request for order ${order?.orderNumber} failed: ${err?.message}`);
      }
      // One attempt only: mark the order whatever happened so a bad address is never retried every hour.
      await orderModel.updateOne({ _id: order._id }, { $set: { reviewRequestSentAt: new Date() } });
      handled++;
    }
    return handled;
  }

  private async handleOrder(order: any, ctx: { from: Date; to: Date; userModel: any; ratingModel: any; storeModel: any }) {
    const user: any = await ctx.userModel.findById(order.userId).select('name email isGuest').lean();
    if (!user?.email || user.isGuest) return; // guests cannot sign in to review

    const due = (order.sellerOrders ?? []).filter(
      (so: any) => DELIVERED.includes(so.status) && so.deliveredAt && new Date(so.deliveredAt) >= ctx.from && new Date(so.deliveredAt) <= ctx.to,
    );
    const productIds: string[] = [...new Set<string>(due.flatMap((so: any) => (so.items ?? []).filter((i: any) => i.status !== 'cancelled').map((i: any) => String(i.productId))))];
    if (productIds.length === 0) return;
    const reviewed: any[] = await ctx.ratingModel.find({ userId: String(order.userId), productId: { $in: productIds }, isDelete: false }).select('productId').lean();
    const alreadyReviewed = new Set(reviewed.map((r) => String(r.productId)));

    for (const so of due) {
      const items = (so.items ?? []).filter((i: any) => i.status !== 'cancelled' && !alreadyReviewed.has(String(i.productId)));
      if (items.length === 0) continue;
      const store: any = await ctx.storeModel.findById(so.storeId).select('slug customDomain customDomainStatus').lean();
      const base = storePublicUrl(store);
      if (!base) continue;
      const reviewUrl = `${base}/orders/${order._id}`;
      await this.notifications.sendCustomerEmail({
        to: user.email,
        storeId: String(so.storeId),
        event: 'review_request',
        orderId: String(order._id),
        vars: {
          customerName: user.name ?? '',
          orderNumber: String(order.orderNumber),
          itemList: items.map((i: any) => `• ${i.name}`).join('\n'),
          reviewUrl,
        },
        cta: { label: 'Write a review', url: reviewUrl },
      });
    }
  }
}
