/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ModuleRef } from '@nestjs/core';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WhatsAppSenderService } from '../integrations/whatsapp-sender.service';
import { storePublicUrl } from '../newsletter/marketing-email.util';
import { OrdersService } from '../orders/orders.service';
import { signCodConfirmToken, verifyCodConfirmToken } from './cod-confirm-token.util';

export type ConfirmationStatus = 'awaiting' | 'confirmed' | 'cancelled' | 'expired';
const PATH = 'codProtection.confirmation';

/**
 * The COD confirmation round trip: send the customer a one-time link (email + WhatsApp when the store has it), let them confirm or cancel
 * from the link, and cancel the order automatically when the window closes (stock goes back like any other cancellation).
 * Every state change is an atomic claim on `codProtection.confirmation.status`, so a double tap, a replayed link or two instances
 * can never resolve the same order twice.
 */
@Injectable()
export class CodConfirmationService {
  private readonly log = new Logger(CodConfirmationService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get orders() { return this.db.repositories.orderModel as any; }
  private ordersService() { return this.moduleRef.get(OrdersService, { strict: false }); }

  /** Sends (or re-sends) the confirmation request for an order that awaits it. A new send invalidates every earlier link. */
  async send(orderId: string): Promise<{ sent: string[] }> {
    const order: any = await this.orders.findOne({ _id: orderId, isDelete: false, [`${PATH}.status`]: 'awaiting' }).lean();
    if (!order) throw new ConflictException('This order is not waiting for confirmation.');
    const storeId = String(order.sellerOrders?.[0]?.storeId ?? '');
    const expiresAt = new Date(order.codProtection.confirmation.expiresAt);
    if (expiresAt.getTime() <= Date.now()) throw new BadRequestException('The confirmation window has closed.');
    const tokenId = randomBytes(8).toString('hex');
    const claim = await this.orders.updateOne({ _id: orderId, [`${PATH}.status`]: 'awaiting' }, { $set: { [`${PATH}.tokenId`]: tokenId, [`${PATH}.sentAt`]: new Date() } });
    if (claim.modifiedCount === 0) throw new ConflictException('This order is not waiting for confirmation.');

    const [store, user]: any[] = await Promise.all([
      this.db.repositories.storeModel.findById(storeId).select('name slug customDomain customDomainStatus').lean(),
      (this.db.repositories as any).userModel.findById(order.userId).select('name email contactEmail isGuest').lean(),
    ]);
    const base = storePublicUrl(store);
    const confirmUrl = base ? `${base}/cod-confirm/${signCodConfirmToken(String(order._id), tokenId, expiresAt)}` : '';
    const hours = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000));
    const total = `${order.currency} ${Number(order.totalAmount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    const channels: string[] = [];
    if (!confirmUrl) return { sent: channels };

    const email = user?.email && !user.isGuest ? user.email : user?.contactEmail ?? null;
    if (email) {
      try {
        await this.notifications.sendCustomerEmail({
          to: email, storeId, event: 'cod_confirmation', orderId: String(order._id),
          vars: { customerName: user?.name ?? '', orderNumber: String(order.orderNumber), orderUrl: confirmUrl, confirmUrl, confirmHours: String(hours), total },
          cta: { label: 'Confirm my order', url: confirmUrl },
        });
        channels.push('email');
      } catch (e: any) { this.log.warn(`COD confirmation email failed for order ${order.orderNumber}: ${e?.message}`); }
    }
    const phone = order.shippingAddress?.phoneNumber;
    if (phone) {
      try {
        await this.moduleRef.get(WhatsAppSenderService, { strict: false }).sendOrderTemplate(storeId, phone, '', 'en_US', undefined, 'cod_confirmation', {
          customer_name: user?.name ?? '', order_number: String(order.orderNumber), total, confirm_url: confirmUrl,
        });
        channels.push('whatsapp');
      } catch (e: any) { this.log.warn(`COD confirmation WhatsApp failed for order ${order.orderNumber}: ${e?.message}`); }
    }
    await this.orders.updateOne({ _id: orderId }, { $set: { [`${PATH}.channels`]: channels } });
    return { sent: channels };
  }

  // ── public (token) side ───────────────────────────────────────────────────
  /** The order a valid, current link points at, or null (bad / expired / superseded link). */
  private async byToken(token: string): Promise<any | null> {
    const claims = verifyCodConfirmToken(token);
    if (!claims) return null;
    const order: any = await this.orders.findOne({ _id: claims.orderId, isDelete: false }).lean();
    if (!order?.codProtection?.confirmation || order.codProtection.confirmation.tokenId !== claims.tokenId) return null;
    return order;
  }

  async publicView(token: string) {
    const order = await this.byToken(token);
    if (!order) throw new NotFoundException('This link is not valid any more.');
    const c = order.codProtection.confirmation;
    const store: any = await this.db.repositories.storeModel.findById(order.sellerOrders?.[0]?.storeId).select('name').lean();
    return {
      storeName: store?.name ?? '', orderNumber: order.orderNumber, total: order.totalAmount, currency: order.currency,
      itemCount: (order.sellerOrders ?? []).reduce((n: number, so: any) => n + (so.items ?? []).filter((i: any) => i.status !== 'cancelled').reduce((s: number, i: any) => s + (i.quantity ?? 0), 0), 0),
      status: this.effective(c) as ConfirmationStatus, expiresAt: c.expiresAt,
    };
  }

  private effective(c: { status: ConfirmationStatus; expiresAt: Date }): ConfirmationStatus {
    return c.status === 'awaiting' && new Date(c.expiresAt).getTime() <= Date.now() ? 'expired' : c.status;
  }

  /** Customer confirms. Idempotent: a repeated tap just reports the current state. */
  async confirm(token: string) {
    const order = await this.byToken(token);
    if (!order) throw new NotFoundException('This link is not valid any more.');
    const now = new Date();
    const won = await this.orders.findOneAndUpdate(
      { _id: order._id, [`${PATH}.status`]: 'awaiting', [`${PATH}.tokenId`]: order.codProtection.confirmation.tokenId, [`${PATH}.expiresAt`]: { $gt: now } },
      { $set: { [`${PATH}.status`]: 'confirmed', [`${PATH}.resolvedAt`]: now, [`${PATH}.resolvedBy`]: 'customer' } },
    ).select('_id').lean();
    if (won) await this.audit(order, 'cod_customer_confirmed', 'confirmed by the customer');
    return this.publicView(token);
  }

  /** Customer cancels from the link: the order is cancelled (stock released) exactly once. */
  async cancel(token: string) {
    const order = await this.byToken(token);
    if (!order) throw new NotFoundException('This link is not valid any more.');
    const now = new Date();
    const won = await this.orders.findOneAndUpdate(
      { _id: order._id, [`${PATH}.status`]: 'awaiting', [`${PATH}.tokenId`]: order.codProtection.confirmation.tokenId, [`${PATH}.expiresAt`]: { $gt: now } },
      { $set: { [`${PATH}.status`]: 'cancelled', [`${PATH}.resolvedAt`]: now, [`${PATH}.resolvedBy`]: 'customer' } },
    ).select('_id').lean();
    if (won) {
      try {
        await this.ordersService().cancelOrder(String(order.userId), String(order._id), { reason: 'Cancelled by the customer from the COD confirmation link' }, String(order.sellerOrders?.[0]?.storeId));
        await this.audit(order, 'cod_customer_cancelled', 'cancelled by the customer');
      } catch (e: any) {
        await this.orders.updateOne({ _id: order._id }, { $set: { [`${PATH}.status`]: 'awaiting', [`${PATH}.resolvedAt`]: null, [`${PATH}.resolvedBy`]: null } });
        this.log.warn(`COD customer cancel of order ${order.orderNumber} failed: ${e?.message}`);
        throw new BadRequestException('We could not cancel this order right now. Please contact the store.');
      }
    }
    return this.publicView(token);
  }

  // ── automatic cancellation ───────────────────────────────────────────────
  @Cron('*/15 * * * *')
  async cron() {
    const r = await this.redis.withLock('cron-lock:cod-confirmation-expiry', 10 * 60_000, async () => {
      const n = await this.expireDue();
      if (n > 0) this.log.log(`${n} unconfirmed COD order(s) cancelled automatically`);
    });
    if (r === 'lock_not_acquired') this.log.debug('Skipped COD expiry: another instance holds the lock (or Redis is unavailable)');
  }

  /** Cancels every COD order whose confirmation window has closed. Idempotent; a failed cancel is retried on the next run. */
  async expireDue(now = new Date(), limit = 100): Promise<number> {
    const due: any[] = await this.orders.find({ isDelete: false, [`${PATH}.status`]: 'awaiting', [`${PATH}.expiresAt`]: { $lte: now } }).select('_id orderNumber sellerOrders.storeId').limit(limit).lean();
    let done = 0;
    for (const o of due) {
      const won = await this.orders.findOneAndUpdate(
        { _id: o._id, [`${PATH}.status`]: 'awaiting', [`${PATH}.expiresAt`]: { $lte: now } },
        { $set: { [`${PATH}.status`]: 'expired', [`${PATH}.resolvedAt`]: now, [`${PATH}.resolvedBy`]: 'system' } },
      ).select('_id').lean();
      if (!won) continue;
      const storeId = String(o.sellerOrders?.[0]?.storeId);
      try {
        const store: any = await this.db.repositories.storeModel.findById(storeId).select('sellerId').lean();
        await this.ordersService().cancelOrderAsSeller(String(store.sellerId), storeId, String(o._id), { reason: 'COD order not confirmed by the customer in time' });
        await this.audit(o, 'cod_auto_cancelled', 'cancelled automatically: the customer did not confirm in time');
        done++;
      } catch (e: any) {
        // Give it another try on the next run (the claim is released).
        await this.orders.updateOne({ _id: o._id, [`${PATH}.status`]: 'expired' }, { $set: { [`${PATH}.status`]: 'awaiting', [`${PATH}.resolvedAt`]: null, [`${PATH}.resolvedBy`]: null } });
        this.log.warn(`COD auto-cancel of order ${o.orderNumber} failed: ${e?.message}`);
      }
    }
    return done;
  }

  private audit(order: any, action: string, text: string) {
    return this.activity.log({ storeId: String(order.sellerOrders?.[0]?.storeId ?? ''), category: 'orders', action, description: `COD order #${order.orderNumber} ${text}`, actorId: 'system', actorRole: 'system', targetId: String(order._id), targetType: 'order' } as any).catch(() => undefined);
  }
}
