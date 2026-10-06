/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PaymentService } from '../payment/payment.service';
import { FinanceService } from '../finance/finance.service';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { GiftCardsService } from '../gift-cards/gift-cards.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { round } from '../common/number.util';
import { releaseRefundCapacity, reserveRefundCapacity } from '../common/refund-cap.util';
import { effectiveReturnStatus } from '../common/return-status.util';
import { deriveSellerReturnStatus } from './order-exchange.util';
import {
  canApplyReturnAction, canReceiveReturnLine, canRefundReturnLine, pickRestockChoice, RETURN_ACTION_FROM, RETURN_ACTION_TO,
  splitRefundShares, type ReturnAction,
} from './order-returns.util';
import { ReceiveReturnDto, RefundReturnDto } from './dto/order-returns.dto';

type Actor = { actorId: string; actorRole: 'seller' | 'staff' };

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * Shopify RETURNS flow (money/stock only move when Shopify's would):
 *   buyer requests -> seller APPROVES (or declines) [no money, no stock] -> seller buys a return label (optional)
 *   -> goods arrive: seller MARKS RECEIVED (+ restock choice: back to sellable stock / damaged / untouched) [stock moves here]
 *   -> seller RESOLVES the received line: REFUND (to the original payment method or store credit) [money moves here] or
 *      EXCHANGE (`OrderExchangeService`). A return can also be CLOSED without a refund.
 * The refund is the block that used to run at return approval: one shared refund budget (`common/refund-cap.util.ts`),
 * ledger reversal in the seller's settlement currency, a real Stripe refund for stripe orders (or store credit), loyalty
 * clawback and gift-card / store-credit restoration. Every step is a conditional update on the previous `returnStatus`, so a
 * double click / two reviewers can never do it twice.
 * Orders approved + refunded under the old "refund on approval" behaviour stay valid: see `common/return-status.util.ts`.
 */
@Injectable()
export class OrderReturnsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly paymentService: PaymentService,
    private readonly finance: FinanceService,
    private readonly storeCredit: StoreCreditService,
    private readonly giftCards: GiftCardsService,
    private readonly loyalty: LoyaltyService,
  ) {}

  private get r() { return this.db.repositories; }

  private async loadOwned(sellerId: string, storeId: string, orderId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!Types.ObjectId.isValid(orderId)) throw new NotFoundException('Order not found');
    const store: any = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('baseCurrency name').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const order: any = await this.r.orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = (order.sellerOrders as any[]).findIndex((s: any) => s.storeId === storeId && s.sellerId === sellerId);
    if (soIndex === -1) throw new ForbiddenException('No orders found for this store');
    return { store, order, soIndex };
  }

  private pickLines(so: any, itemIds: string[]) {
    const ids = [...new Set((itemIds ?? []).map(String))];
    if (ids.length === 0) throw new BadRequestException('itemIds are required');
    return ids.map((id) => {
      const i = (so.items as any[]).findIndex((it: any) => String(it._id) === id);
      if (i === -1) throw new BadRequestException(`Item not found: ${id}`);
      return { i, item: so.items[i] };
    });
  }

  private async timeline(orderId: string, type: string, message: string, actor: Actor | null) {
    try {
      await this.r.orderModel.updateOne({ _id: orderId }, { $push: { timeline: { type, message, actorId: actor?.actorId ?? null, actorRole: actor?.actorRole ?? 'system', createdAt: new Date() } } });
    } catch { /* informational */ }
  }

  /**
   * Atomically moves ALL given lines out of `fromStatuses` (one conditional updateOne: a lost race changes nothing and
   * returns false). `setFor(item, k)` gives the fields to set per line.
   */
  private async claimLines(orderId: string, soIndex: number, lines: { i: number; item: any }[], fromStatuses: string[], setFor: (item: any, k: number) => Record<string, unknown>, extraSet: Record<string, unknown> = {}) {
    const prefix = `sellerOrders.${soIndex}.items`;
    const filter: any = { _id: orderId };
    const set: any = { ...extraSet };
    lines.forEach(({ i, item }, k) => {
      filter[`${prefix}.${i}.returnStatus`] = fromStatuses.length === 1 ? fromStatuses[0] : { $in: fromStatuses };
      filter[`${prefix}.${i}.exchangeOrderId`] = { $in: [null] };
      for (const [key, val] of Object.entries(setFor(item, k))) set[`${prefix}.${i}.${key}`] = val;
    });
    const res: any = await this.r.orderModel.updateOne(filter, { $set: set });
    return (res.modifiedCount ?? res.nModified ?? 0) > 0;
  }

  /** Re-derives the sub-order's return roll-up from the stored (effective) item statuses. */
  private async recomputeRollup(orderId: string, soIndex: number) {
    const o: any = await this.r.orderModel.findById(orderId).select('sellerOrders').lean();
    const so = o?.sellerOrders?.[soIndex];
    if (!so) return;
    const statuses = (so.items as any[]).filter((it) => it.type === 'physical' && it.status !== 'cancelled').map((it) => effectiveReturnStatus(it));
    await this.r.orderModel.updateOne({ _id: orderId }, { $set: { [`sellerOrders.${soIndex}.returnStatus`]: deriveSellerReturnStatus(statuses) } }).catch(() => undefined);
  }

  private notifyBuyer(order: any, storeId: string, storeName: string, title: string, body: string) {
    this.notifications.notify({
      recipientId: String(order.userId), recipientRole: 'user', type: NOTIFICATION_TYPES.ORDER_UPDATED, storeId,
      title, body, data: { orderId: String(order._id), storeId },
      email: {
        subject: `${title} - order #${order.orderNumber}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>${esc(title)}</h2><p>${esc(body)}</p><p style="color:#888;font-size:12px">${esc(storeName ?? '')}</p></div>`,
      },
    } as any).catch(() => undefined);
  }

  // ── Approve / decline / close (NO money, NO stock) ──
  async action(sellerId: string, orderId: string, body: any, actor: Actor, ip?: string, userAgent?: string) {
    const { storeId, itemIds, action, rejectReason } = body ?? {};
    if (!['approve', 'reject', 'close'].includes(action)) throw new BadRequestException('action must be approve, reject or close');
    const act = action as ReturnAction;
    const { store, order, soIndex } = await this.loadOwned(sellerId, storeId, orderId);
    const so = order.sellerOrders[soIndex];
    const lines = this.pickLines(so, itemIds);
    for (const { item } of lines) {
      const chk = canApplyReturnAction(item, act);
      if (!chk.ok) throw new BadRequestException(`"${item.name}": ${chk.reason}`);
    }

    const now = new Date();
    const reason = typeof rejectReason === 'string' ? rejectReason.trim().slice(0, 300) : '';
    const claimed = await this.claimLines(orderId, soIndex, lines, RETURN_ACTION_FROM[act], () => {
      const f: Record<string, unknown> = { returnStatus: RETURN_ACTION_TO[act] };
      if (act === 'approve') f.returnApprovedAt = now;
      if (act === 'reject' && reason) f.returnRejectReason = reason;
      if (act === 'close') { f.returnResolvedAt = now; f.returnResolution = 'closed'; if (reason) f.returnRejectReason = reason; }
      return f;
    }, act === 'approve' ? { hasReturnApproved: true } : {});
    if (!claimed) throw new ConflictException('These return items were just handled by someone else - refresh and try again.');
    await this.recomputeRollup(orderId, soIndex);

    const names = lines.map((l) => l.item.name).join(', ');
    const verb = act === 'approve' ? 'approved' : act === 'reject' ? 'declined' : 'closed';
    await this.timeline(orderId, 'return', `Return ${verb}: ${names}${reason ? ` - ${reason}` : ''}`, actor);
    this.activityLog.log({
      storeId, category: 'orders', action: act === 'approve' ? 'return_approved' : act === 'reject' ? 'return_rejected' : 'return_closed',
      description: `Order #${order.orderNumber} - ${lines.length} item(s) return ${verb}`,
      actorId: actor.actorId, actorRole: actor.actorRole, targetId: orderId, targetType: 'order', ip, userAgent,
    });
    if (act === 'approve') {
      this.notifyBuyer(order, storeId, store.name, 'Your return was approved', `Your return request for order #${order.orderNumber} was approved. Please send the item(s) back - your refund is issued once the store receives them.`);
    } else if (act === 'reject') {
      this.notifyBuyer(order, storeId, store.name, 'Your return was declined', `Your return request for order #${order.orderNumber} was declined${reason ? `: ${reason}` : '.'}`);
    } else {
      this.notifyBuyer(order, storeId, store.name, 'Your return was closed', `The return for order #${order.orderNumber} was closed by the store${reason ? `: ${reason}` : '.'}`);
    }
    return { success: true, message: `Return ${verb} for ${lines.length} item(s)`, data: { orderId, action: act, processedItems: lines.length, refundProcessed: false } };
  }

  // ── Mark as received (+ restock choice) ──
  async receive(sellerId: string, storeId: string, orderId: string, actor: Actor, dto: ReceiveReturnDto) {
    const { store, order, soIndex } = await this.loadOwned(sellerId, storeId, orderId);
    const so = order.sellerOrders[soIndex];
    const lines = this.pickLines(so, dto.itemIds);
    for (const { item } of lines) {
      const chk = canReceiveReturnLine(item);
      if (!chk.ok) throw new BadRequestException(`"${item.name}": ${chk.reason}`);
    }
    const now = new Date();
    const choices = lines.map(({ item }) => pickRestockChoice(String(item._id), dto.restockDecisions, dto.restock));
    const claimed = await this.claimLines(orderId, soIndex, lines, ['approved'], (_item, k) => ({ returnStatus: 'received', returnReceivedAt: now, returnRestock: choices[k] }));
    if (!claimed) throw new ConflictException('These return items were just handled by someone else - refresh and try again.');
    await this.recomputeRollup(orderId, soIndex);

    // Stock moves here (never at approval). Only after the claim succeeded, so a double click can never restock twice.
    const stockProblems: string[] = [];
    const seller: any = await this.r.sellerModel.findOne({ _id: sellerId }).select('name');
    for (let k = 0; k < lines.length; k++) {
      const { item } = lines[k];
      const choice = choices[k];
      if (choice === 'none' || item.type !== 'physical' || !item.variantId) continue;
      try {
        const variant: any = await this.r.productVariantModel.findOne({ _id: item.variantId, isDelete: false });
        if (!variant || variant.unlimitedStock) continue;
        const qty = item.quantity;
        const previousStock = variant.stock;
        await this.r.productVariantModel.updateOne({ _id: item.variantId }, choice === 'restock' ? { $inc: { stock: qty } } : { $inc: { stock: qty, damagedStock: qty } });
        await this.r.stockAdjustmentModel.create({
          storeId, productId: item.productId, variantId: item.variantId, locationId: null,
          productName: item.name, sku: item.sku ?? null,
          previousStock, newStock: previousStock + qty, delta: qty,
          reason: choice === 'restock' ? 'return' : 'damaged',
          note: `Return received for order #${order.orderNumber}`,
          adjustedBy: actor.actorId, adjustedByName: seller?.name ?? null,
        });
      } catch (e: any) {
        stockProblems.push(item.name);
        await this.activityLog.log({
          storeId, category: 'orders', action: 'return_restock_failed',
          description: `Order #${order.orderNumber}: restocking "${item.name}" failed (${e?.message}) - adjust the stock by hand`,
          actorId: actor.actorId, actorRole: actor.actorRole, isSecurityAlert: true, targetId: orderId, targetType: 'order',
        });
      }
    }

    const names = lines.map((l) => l.item.name).join(', ');
    const stockText = choices.every((c) => c === 'none') ? 'not restocked' : choices.every((c) => c === 'restock') ? 'restocked' : 'restock choices applied';
    await this.timeline(orderId, 'return', `Return received: ${names} (${stockText})${dto.note?.trim() ? ` - ${dto.note.trim().slice(0, 300)}` : ''}`, actor);
    this.activityLog.log({
      storeId, category: 'orders', action: 'return_received',
      description: `Order #${order.orderNumber} - ${lines.length} returned item(s) received (${stockText})`,
      actorId: actor.actorId, actorRole: actor.actorRole, targetId: orderId, targetType: 'order',
    });
    this.notifyBuyer(order, storeId, store.name, 'We received your return', `The store received your returned item(s) for order #${order.orderNumber}. Your refund or exchange is being processed.`);
    return {
      success: true,
      message: stockProblems.length ? `Marked as received, but restocking failed for: ${stockProblems.join(', ')} - adjust stock manually` : 'Marked as received',
      data: { orderId, receivedItems: lines.length, stockProblems },
    };
  }

  // ── Resolve: REFUND (the money block that used to run at approval) ──
  async refund(sellerId: string, storeId: string, orderId: string, actor: Actor, dto: RefundReturnDto) {
    const { store, order, soIndex } = await this.loadOwned(sellerId, storeId, orderId);
    const so = order.sellerOrders[soIndex];
    const lines = this.pickLines(so, dto.itemIds);
    for (const { item } of lines) {
      const chk = canRefundReturnLine(item);
      if (!chk.ok) throw new BadRequestException(`"${item.name}": ${chk.reason}`);
    }
    const toStoreCredit = dto.refundTo === 'store_credit';
    const sortedIds = lines.map((l) => String(l.item._id)).sort();
    const refKey = `return:${orderId}:${sortedIds.join(',')}`;
    const buyerCurrency: string = order.currency || 'USD';
    const wantedPerLine = lines.map((l) => round((l.item.totalPrice || 0) + (l.item.taxUSD || 0)));
    const wanted = round(wantedPerLine.reduce((s, w) => s + w, 0));

    // Money first comes out of the ONE shared refund budget (clamped to what is left - part of these items may already
    // have been refunded another way), then the lines are claimed atomically so a double click can't refund twice.
    let granted = 0;
    if (order.isPaid) granted = await reserveRefundCapacity(this.r.orderModel, orderId, soIndex, wanted, { clamp: true });
    const shares = splitRefundShares(wantedPerLine, granted);
    const now = new Date();
    const refundTo = order.isPaid ? (toStoreCredit ? 'store_credit' : 'original') : null;
    const claimed = await this.claimLines(orderId, soIndex, lines, ['received'], (_item, k) => ({
      returnStatus: 'refunded', returnResolvedAt: now, returnResolution: 'refund', returnRefundTo: refundTo, refundedAmount: shares[k],
    }));
    if (!claimed) {
      await releaseRefundCapacity(this.r.orderModel, orderId, soIndex, granted).catch(() => undefined);
      throw new ConflictException('These return items were just handled by someone else - refresh and try again.');
    }
    const unclaim = async () => {
      const prefix = `sellerOrders.${soIndex}.items`;
      const undo: any = {};
      lines.forEach(({ i }) => {
        undo[`${prefix}.${i}.returnStatus`] = 'received';
        undo[`${prefix}.${i}.returnResolvedAt`] = null;
        undo[`${prefix}.${i}.returnResolution`] = null;
        undo[`${prefix}.${i}.returnRefundTo`] = null;
        undo[`${prefix}.${i}.refundedAmount`] = 0;
      });
      await this.r.orderModel.updateOne({ _id: orderId }, { $set: undo }).catch(() => undefined);
      await releaseRefundCapacity(this.r.orderModel, orderId, soIndex, granted).catch(() => undefined);
    };

    let refundProcessed = false;
    let refundNote = order.isPaid ? '' : 'The order was not paid, so there was nothing to refund.';
    if (order.isPaid) {
      if (granted > 0) {
        if (toStoreCredit) {
          // Shopify "Refund to store credit": no card refund and no ledger debit - the money stays with the store.
          try {
            const storeCurrency = store.baseCurrency ?? buyerCurrency;
            const credit = round(this.exchangeRate.convertWithSnapshots(granted, buyerCurrency, storeCurrency, order.fxSnapshots ?? []));
            await this.storeCredit.creditFromRefund(storeId, order.userId, credit, orderId, refKey, `Order #${order.orderNumber} - return refunded`, { actorId: actor.actorId, actorRole: 'seller' } as any);
            refundProcessed = true;
            refundNote = `${granted.toFixed(2)} ${buyerCurrency} refunded to store credit`;
          } catch (err) {
            await unclaim();
            throw err;
          }
        } else {
          // The amount is in the order's own charge currency; the seller's wallet is debited in THEIR settlement currency.
          const settlementCurrency = so.settlementCurrency ?? buyerCurrency;
          const sellerDebitAmount = this.exchangeRate.convertWithSnapshots(granted, buyerCurrency, settlementCurrency, order.fxSnapshots ?? []);
          try {
            await this.finance.recordRefund(storeId, sellerId, orderId, sellerDebitAmount, sellerId, 'seller', {
              description: `Return refunded - Order #${order.orderNumber}`, targetType: 'order', currency: settlementCurrency,
            });
            refundProcessed = true;
          } catch (e: any) {
            console.error('Finance recordRefund failed:', e?.message);
          }
          // Real buyer-facing Stripe refund (mirrors refund-request approve()).
          if (order.paymentType === 'stripe') {
            const transaction: any = await this.r.paymentTransactionModel.findOne({ orderIds: orderId, status: 'completed', isDelete: false });
            if (transaction?.stripePaymentIntentId) {
              try {
                const key = `return_refund_${orderId}_${createHash('sha1').update(sortedIds.join(',')).digest('hex').slice(0, 24)}`;
                await this.paymentService.refundStripePaymentIntent(transaction.stripePaymentIntentId, granted, key);
                refundNote = `${granted.toFixed(2)} ${buyerCurrency} refunded to the original payment method`;
              } catch (e: any) {
                refundNote = `STRIPE REFUND FAILED (${e?.message}) - refund ${granted.toFixed(2)} ${buyerCurrency} manually`;
                await this.activityLog.log({
                  storeId: 'platform', category: 'finance', action: 'stripe_refund_failed_after_ledger_reversal',
                  description: `Stripe refund failed for order #${order.orderNumber} after seller ledger was already reversed (return refund): ${e?.message}`,
                  actorId: sellerId, actorRole: 'seller', isSecurityAlert: true, targetId: orderId, targetType: 'order',
                });
              }
            }
          } else {
            refundNote = `${granted.toFixed(2)} ${buyerCurrency} was paid outside the platform - refund it to the customer yourself`;
          }
        }
        this.loyalty.clawbackPurchasePoints(storeId, order.userId, orderId, granted).catch(() => {});
      }

      // Gift-card / store-credit balances the buyer used on these lines come back - a return is a refund too.
      if (order.giftCardCode) {
        const amt = lines.reduce((s, l) => s + (l.item.giftCardDiscountUSD || 0), 0);
        if (amt > 0) {
          await this.giftCards.restoreOnRefund(storeId, order.giftCardCode, amt, orderId, refKey, `Order #${order.orderNumber} - return refunded`)
            .catch((e: any) => console.error('Gift card reversal failed (return refund):', e?.message));
        }
      }
      const scAmt = lines.reduce((s, l) => s + (l.item.storeCreditDiscountUSD || 0), 0);
      if (scAmt > 0) {
        await this.storeCredit.restoreOnRefund(storeId, order.userId, scAmt, orderId, refKey, `Order #${order.orderNumber} - return refunded`)
          .catch((e: any) => console.error('Store credit reversal failed (return refund):', e?.message));
      }
    }
    await this.recomputeRollup(orderId, soIndex);

    const names = lines.map((l) => l.item.name).join(', ');
    await this.timeline(orderId, 'refund', `Return refunded: ${names}. ${refundNote}${dto.note?.trim() ? ` - ${dto.note.trim().slice(0, 300)}` : ''}`, actor);
    this.activityLog.log({
      storeId, category: 'orders', action: 'return_refunded',
      description: `Order #${order.orderNumber} - return refunded for ${lines.length} item(s)${granted > 0 ? ` (${granted.toFixed(2)} ${buyerCurrency}${toStoreCredit ? ' as store credit' : ''})` : ''}`,
      actorId: actor.actorId, actorRole: actor.actorRole, targetId: orderId, targetType: 'order',
    });
    if (granted > 0 && refundProcessed) {
      this.notifications.notify({
        recipientId: String(order.userId), recipientRole: 'user', type: NOTIFICATION_TYPES.REFUND_ISSUED, storeId,
        title: 'Refund issued', body: `You've been refunded ${granted.toFixed(2)} ${buyerCurrency}${toStoreCredit ? ' as store credit' : ''} for your return on order #${order.orderNumber}.`,
        data: { orderId },
      } as any).catch(() => undefined);
    }
    return {
      success: true,
      message: refundNote || 'Return refunded',
      data: { orderId, resolvedItems: lines.length, refundedAmount: granted, refundedTo: refundTo, refundProcessed, refundNote },
    };
  }
}
