/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { availableStock, AVAILABLE_STOCK_EXPR } from '@/common/stock-availability.util';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PaymentService } from '../payment/payment.service';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { round } from '../common/number.util';
import { remainingRefundable } from '../common/refund-cap.util';
import { EditOrderDto, OrderShippingAddressDto } from './dto/order-editing.dto';

type Actor = { actorId: string; actorRole: 'seller' | 'staff' };

const EDITABLE = ['pending', 'processing'];
const DISCOUNT_FIELDS = ['subscriberDiscountUSD', 'couponDiscountUSD', 'giftCardDiscountUSD', 'storeCreditDiscountUSD', 'campaignDiscountUSD', 'autoDiscountUSD'] as const;

/**
 * Shopify's "Edit order" (+ the order TIMELINE, merchant NOTES and "Edit shipping address").
 *
 * Edit order lets the merchant change quantities, remove items and add products on the UNFULFILLED part of an order.
 * Rules that keep the money correct (anything outside them is refused with a clear message rather than guessed):
 *  - only this store's own sub-order, only items still pending/processing, order not cancelled/completed;
 *  - a PAID order can only get cheaper (reduce/remove) — the difference is refunded to the original payment method or
 *    to store credit; making a paid order more expensive is refused (collect the extra with a new draft order);
 *  - adding/increasing is allowed on UNPAID cash-on-delivery orders (nothing was charged);
 *  - orders paid with a gift card or store credit can't be edited (the discount would have to be re-split and restored);
 *  - an online payment that is only AUTHORIZED (manual capture) or a bank transfer awaiting verification can't be edited
 *    (the held / proven amount would no longer match).
 * Stock reservations (committedStock) follow every quantity change atomically; the order is claimed with an optimistic
 * lock BEFORE any money moves; every edit lands on the order timeline.
 */
@Injectable()
export class OrderEditingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly paymentService: PaymentService,
    private readonly storeCredit: StoreCreditService,
  ) {}

  private get r() { return this.db.repositories; }

  private async loadOwned(sellerId: string, storeId: string, orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Order not found');
    const store: any = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('baseCurrency name').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const order: any = await this.r.orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = (order.sellerOrders as any[]).findIndex((s: any) => s.storeId === storeId && s.sellerId === sellerId);
    if (soIndex === -1) throw new ForbiddenException('Unauthorized');
    return { store, order, soIndex };
  }

  private entry(type: string, message: string, actor: Actor | null) {
    return { type, message, actorId: actor?.actorId ?? null, actorRole: actor?.actorRole ?? 'system', createdAt: new Date() };
  }

  /** Append a system event to an order's timeline (best-effort — never blocks the action that caused it). */
  async addTimelineEvent(orderId: string, type: string, message: string, actor: Actor | null) {
    try {
      await this.r.orderModel.updateOne({ _id: orderId }, { $push: { timeline: this.entry(type, message, actor) } });
    } catch { /* timeline is informational */ }
  }

  // ── Shopify "Leave a comment" on the timeline ──
  async addComment(sellerId: string, storeId: string, orderId: string, actor: Actor, message: string) {
    const { order } = await this.loadOwned(sellerId, storeId, orderId);
    const text = (message ?? '').trim();
    if (!text) throw new BadRequestException('Write a comment first');
    const e = this.entry('comment', text.slice(0, 2000), actor);
    await this.r.orderModel.updateOne({ _id: order._id }, { $push: { timeline: e } });
    return { success: true, message: 'Comment added', data: e };
  }

  // ── Shopify "Notes" card ──
  async updateNote(sellerId: string, storeId: string, orderId: string, actor: Actor, note: string) {
    const { order } = await this.loadOwned(sellerId, storeId, orderId);
    const clean = (note ?? '').trim().slice(0, 2000);
    await this.r.orderModel.updateOne({ _id: order._id }, { $set: { note: clean }, $push: { timeline: this.entry('note', clean ? 'Order note updated' : 'Order note removed', actor) } });
    return { success: true, message: 'Note saved', data: { note: clean } };
  }

  // ── Shopify "Edit shipping address" (until the items ship) ──
  async updateShippingAddress(sellerId: string, storeId: string, orderId: string, actor: Actor, dto: OrderShippingAddressDto) {
    const { order, soIndex } = await this.loadOwned(sellerId, storeId, orderId);
    if (['cancelled', 'refunded', 'completed'].includes(order.orderStatus)) throw new BadRequestException('This order can no longer be changed');
    if (order.sellerOrders.length > 1) throw new BadRequestException('The address of a multi-store order is shared and cannot be edited here');
    const so = order.sellerOrders[soIndex];
    if (!EDITABLE.includes(so.status)) throw new BadRequestException('The address can only be changed before the order ships');
    const addr = {
      recipientName: dto.recipientName.trim(), phoneNumber: dto.phoneNumber.trim(), addressLine1: dto.addressLine1.trim(),
      addressLine2: dto.addressLine2?.trim() || null, city: dto.city.trim(), state: dto.state.trim(),
      zipCode: dto.zipCode.trim(), country: dto.country?.trim() || order.shippingAddress?.country || null,
    };
    if (!addr.recipientName || !addr.addressLine1 || !addr.city) throw new BadRequestException('Name, address and city are required');
    await this.r.orderModel.updateOne({ _id: order._id }, { $set: { shippingAddress: addr }, $push: { timeline: this.entry('address', 'Shipping address updated', actor) } });
    return { success: true, message: 'Shipping address updated', data: addr };
  }

  // ── Shopify "Edit order" ──
  async editOrder(sellerId: string, storeId: string, orderId: string, actor: Actor, dto: EditOrderDto) {
    const changes = dto.changes ?? [];
    const additions = dto.additions ?? [];
    if (changes.length === 0 && additions.length === 0) throw new BadRequestException('Nothing to change');

    const { store, order, soIndex } = await this.loadOwned(sellerId, storeId, orderId);

    if (['cancelled', 'refunded', 'completed'].includes(order.orderStatus)) throw new BadRequestException('This order can no longer be edited');
    if ((order.giftCardDiscountTotal ?? 0) > 0 || (order.storeCreditDiscountTotal ?? 0) > 0) {
      throw new BadRequestException('Orders paid (even partly) with a gift card or store credit cannot be edited — cancel the order and create a new one.');
    }
    if (order.paymentType === 'stripe' && !order.isPaid) throw new BadRequestException('This payment is only authorized — capture it before editing the order.');
    if (order.paymentStatus === 'pending_verification') throw new BadRequestException('A bank-transfer payment is awaiting verification — approve or reject it before editing the order.');

    const plain: any = order.toObject();
    const so = plain.sellerOrders[soIndex];
    if (!EDITABLE.includes(so.status)) throw new BadRequestException('Only unfulfilled orders can be edited');
    if (Array.isArray(so.shipments) && so.shipments.length > 0) throw new BadRequestException('Part of this order has already shipped, so it can no longer be edited.');

    const increases = additions.length > 0 || changes.some((c) => {
      const it = so.items.find((i: any) => String(i._id) === c.itemId);
      return it && c.quantity > it.quantity;
    });
    if (increases && (order.isPaid || order.paymentType !== 'cash_on_delivery')) {
      throw new BadRequestException('Items can only be added or increased on an unpaid cash-on-delivery order. For a paid order, create a new draft order for the extra items.');
    }

    // ── 1) compute the new items ──
    const seen = new Set<string>();
    const lines: string[] = [];
    const stockMoves: Array<{ variantId: string; delta: number; unlimited: boolean; allowBackorder: boolean }> = [];
    let dSubtotal = 0, dTax = 0, dSponsored = 0;
    const dDiscounts: Record<string, number> = {};
    for (const f of DISCOUNT_FIELDS) dDiscounts[f] = 0;
    let removedAll = true;

    for (const c of changes) {
      if (seen.has(c.itemId)) throw new BadRequestException('An item appears twice in the edit');
      seen.add(c.itemId);
      const item = so.items.find((i: any) => String(i._id) === c.itemId);
      if (!item) throw new BadRequestException('Item not found on this order');
      if (!EDITABLE.includes(item.status) || (item.returnStatus && item.returnStatus !== 'none')) throw new BadRequestException(`"${item.name}" can no longer be edited`);
      if (c.quantity === item.quantity) continue;
      const oldQty = item.quantity;
      const ratio = c.quantity / oldQty;
      const before = { total: item.totalPrice ?? 0, tax: item.taxUSD ?? 0, camp: item.campaignSponsorType === 'platform' ? (item.campaignDiscountUSD ?? 0) : 0 };
      if (c.quantity === 0) {
        item.status = 'cancelled'; item.cancelledAt = new Date(); item.cancelReason = dto.reason?.trim() || 'Removed in order edit';
        item.quantity = 0; item.totalPrice = 0; item.taxUSD = 0;
        for (const f of DISCOUNT_FIELDS) { dDiscounts[f] -= item[f] ?? 0; item[f] = 0; }
        lines.push(`Removed ${item.name}`);
      } else {
        item.quantity = c.quantity;
        item.totalPrice = round(before.total * ratio);
        item.taxUSD = round(before.tax * ratio);
        for (const f of DISCOUNT_FIELDS) { const old = item[f] ?? 0; item[f] = round(old * ratio); dDiscounts[f] += item[f] - old; }
        lines.push(`${item.name}: quantity ${oldQty} → ${c.quantity}`);
      }
      dSubtotal += (item.totalPrice ?? 0) - before.total;
      dTax += (item.taxUSD ?? 0) - before.tax;
      dSponsored += (item.campaignSponsorType === 'platform' ? (item.campaignDiscountUSD ?? 0) : 0) - before.camp;
      if (item.type === 'physical' && item.variantId) stockMoves.push({ variantId: item.variantId, delta: c.quantity - oldQty, unlimited: false, allowBackorder: false });
    }
    for (const it of so.items) { if (it.status !== 'cancelled') removedAll = false; }
    if (removedAll) throw new BadRequestException('You cannot remove every item — cancel the order instead.');

    const effTaxRate = so.subtotal > 0 ? (so.taxAmount ?? 0) / so.subtotal : 0;
    for (const a of additions) {
      const variant: any = await this.r.productVariantModel.findOne({ _id: a.variantId, isDelete: false }).lean();
      if (!variant) throw new BadRequestException('A product you tried to add is no longer available');
      const product: any = await this.r.productModel.findOne({ _id: variant.productId, storeId, sellerId, isDelete: false }).lean();
      if (!product || product.status !== 'active') throw new BadRequestException('A product you tried to add is not an active product of this store');
      if (product.type !== 'physical') throw new BadRequestException('Only physical products can be added to an order');
      const unit = round(this.exchangeRate.convertWithSnapshots(variant.price, store.baseCurrency, order.currency, order.fxSnapshots ?? []));
      const total = round(unit * a.quantity);
      const tax = round(total * effTaxRate);
      so.items.push({
        _id: new Types.ObjectId(), productId: String(product._id), variantId: String(variant._id), type: 'physical',
        productType: product.productType ?? null, name: product.name, image: variant.images?.[0] ?? product.images?.[0] ?? null,
        sku: variant.sku ?? null, options: variant.options ?? [], licenseType: null, quantity: a.quantity,
        price: unit, totalPrice: total, originalPrice: unit,
        subscriberDiscountUSD: 0, couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0,
        campaignId: null, campaignDiscountUSD: 0, campaignSponsorType: null, autoDiscountId: null, autoDiscountUSD: 0,
        taxUSD: tax, isBackordered: false, status: 'pending', refundedAmount: 0, downloadCount: 0, returnStatus: 'none',
      });
      dSubtotal += total; dTax += tax;
      stockMoves.push({ variantId: String(variant._id), delta: a.quantity, unlimited: !!variant.unlimitedStock, allowBackorder: !!variant.allowBackorder });
      lines.push(`Added ${product.name} × ${a.quantity}`);
    }
    if (lines.length === 0) throw new BadRequestException('Nothing to change');

    // ── 2) totals (deltas — earlier cancellations keep their own bookkeeping) ──
    const settleCur = so.settlementCurrency ?? order.currency;
    so.subtotal = round(so.subtotal + dSubtotal);
    so.taxAmount = round((so.taxAmount ?? 0) + dTax);
    so.platformSponsoredDiscountUSD = round((so.platformSponsoredDiscountUSD ?? 0) + dSponsored);
    if (so.settlementAmount != null) {
      so.settlementAmount = round(so.settlementAmount + this.exchangeRate.convertWithSnapshots(dSubtotal + dTax + dSponsored, order.currency, settleCur, order.fxSnapshots ?? []));
    }
    const delta = round(dSubtotal + dTax);
    const newTotals = {
      subtotal: round(order.subtotal + dSubtotal),
      taxAmount: round((order.taxAmount ?? 0) + dTax),
      totalAmount: round(order.totalAmount + delta),
      subscriberDiscountTotal: round((order.subscriberDiscountTotal ?? 0) + dDiscounts.subscriberDiscountUSD),
      couponDiscountTotal: round((order.couponDiscountTotal ?? 0) + dDiscounts.couponDiscountUSD),
      campaignDiscountTotal: round((order.campaignDiscountTotal ?? 0) + dDiscounts.campaignDiscountUSD),
      autoDiscountTotal: round((order.autoDiscountTotal ?? 0) + dDiscounts.autoDiscountUSD),
    };
    if (newTotals.totalAmount < 0) throw new BadRequestException('The edit would make the order total negative');

    // A paid order that already had money refunded another way (cancel / manual refund / return) can only be refunded what is
    // still left in the shared refund budget — never the same money twice.
    const refundAmount = order.isPaid && delta < 0 ? Math.min(round(-delta), remainingRefundable(order.sellerOrders[soIndex])) : 0;
    const summary = {
      oldTotal: order.totalAmount, newTotal: newTotals.totalAmount, delta, currency: order.currency,
      refundAmount, amountDue: !order.isPaid && delta > 0 ? delta : 0, lines,
    };
    if (dto.dryRun) return { success: true, message: 'Preview', data: summary };

    // roll sub-order status up (a sub-order with every item gone was already refused above)
    const live = so.items.filter((i: any) => i.status !== 'cancelled');
    if (live.length > 0 && live.every((i: any) => i.status === 'processing')) so.status = 'processing';

    // ── 3) stock reservations (atomic; rolled back if anything later fails) ──
    const applied: Array<{ variantId: string; delta: number }> = [];
    const rollbackStock = async () => {
      for (const m of applied) {
        await this.r.productVariantModel.updateOne({ _id: m.variantId }, [{ $set: { committedStock: { $max: [0, { $subtract: ['$committedStock', m.delta] }] } } }]);
      }
    };
    try {
      for (const m of stockMoves) {
        if (m.delta === 0) continue;
        if (m.delta > 0) {
          const v: any = await this.r.productVariantModel.findOne({ _id: m.variantId }).select('unlimitedStock allowBackorder').lean();
          if (v?.unlimitedStock || v?.allowBackorder) {
            await this.r.productVariantModel.updateOne({ _id: m.variantId }, { $inc: { committedStock: m.delta } });
          } else {
            const res: any = await this.r.productVariantModel.updateOne(
              { _id: m.variantId, isDelete: false, $expr: { $gte: [AVAILABLE_STOCK_EXPR, m.delta] } },
              { $inc: { committedStock: m.delta } },
            );
            if ((res.modifiedCount ?? res.nModified ?? 0) === 0) throw new BadRequestException('Not enough stock for the increased quantity');
          }
        } else {
          await this.r.productVariantModel.updateOne({ _id: m.variantId, unlimitedStock: { $ne: true } }, [{ $set: { committedStock: { $max: [0, { $add: ['$committedStock', m.delta] }] } } }]);
        }
        applied.push({ variantId: m.variantId, delta: m.delta });
      }

      // ── 4) claim the order (optimistic lock) BEFORE any money moves ──
      const message = `Order edited: ${lines.join('; ')}. Total ${order.totalAmount.toFixed(2)} → ${newTotals.totalAmount.toFixed(2)} ${order.currency}`;
      const claimed = await this.r.orderModel.findOneAndUpdate(
        { _id: order._id, updatedAt: order.updatedAt },
        {
          $set: { sellerOrders: plain.sellerOrders, ...newTotals },
          $push: { timeline: this.entry('edit', message, actor) },
        },
      );
      if (!claimed) throw new BadRequestException('This order was just modified by someone else — refresh and try again.');
    } catch (err) {
      await rollbackStock().catch(() => undefined);
      throw err;
    }

    // ── 5) money: refund the difference on a paid order ──
    let refundNote = '';
    if (refundAmount > 0) {
      const toCredit = dto.refundTo === 'store_credit';
      try {
        if (toCredit) {
          const credit = round(this.exchangeRate.convertWithSnapshots(refundAmount, order.currency, store.baseCurrency, order.fxSnapshots ?? []));
          await this.storeCredit.creditFromRefund(storeId, order.userId, credit, String(order._id), `edit:${order._id}:${newTotals.totalAmount}`, `Order #${order.orderNumber} edited`, { actorId: actor.actorId, actorRole: 'seller' } as any);
          refundNote = `Refunded ${refundAmount.toFixed(2)} ${order.currency} to store credit`;
        } else if (order.paymentType === 'stripe') {
          const txn: any = await this.r.paymentTransactionModel.findOne({ orderIds: String(order._id), status: 'completed', isDelete: false });
          if (!txn?.stripePaymentIntentId) throw new Error('No completed Stripe payment found for this order');
          await this.paymentService.refundStripePaymentIntent(txn.stripePaymentIntentId, refundAmount, `order_edit_${order._id}_${newTotals.totalAmount}`);
          refundNote = `Refunded ${refundAmount.toFixed(2)} ${order.currency} to the original payment method`;
        } else {
          refundNote = `${refundAmount.toFixed(2)} ${order.currency} was paid outside the platform — refund it to the customer manually`;
        }
      } catch (err: any) {
        refundNote = `REFUND FAILED (${err?.message}) — refund ${refundAmount.toFixed(2)} ${order.currency} manually`;
        await this.activityLog.log({
          storeId, category: 'finance', action: 'order_edit_refund_failed',
          description: `Order #${order.orderNumber} was edited (−${refundAmount.toFixed(2)} ${order.currency}) but the refund failed: ${err?.message}`,
          actorId: actor.actorId, actorRole: actor.actorRole, isSecurityAlert: true, targetId: String(order._id), targetType: 'order',
        });
      }
      await this.addTimelineEvent(String(order._id), 'refund', refundNote, actor);
    }

    await this.activityLog.log({
      storeId, category: 'orders', action: 'order_edited',
      description: `Order #${order.orderNumber} edited: ${lines.join('; ')}`,
      actorId: actor.actorId, actorRole: actor.actorRole, targetId: String(order._id), targetType: 'order',
    });
    this.notifications.notify({
      recipientId: String(order.userId), recipientRole: 'user', type: NOTIFICATION_TYPES.ORDER_UPDATED,
      title: 'Your order was updated',
      body: `The store updated order #${order.orderNumber}. New total: ${newTotals.totalAmount.toFixed(2)} ${order.currency}.${refundNote && !refundNote.startsWith('REFUND FAILED') ? ' ' + refundNote + '.' : ''}`,
      data: { orderId: String(order._id) },
    }).catch(() => undefined);

    return { success: true, message: 'Order updated', data: { ...summary, refundNote } };
  }
}
