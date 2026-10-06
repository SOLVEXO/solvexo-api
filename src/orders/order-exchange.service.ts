/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { PaymentService } from '../payment/payment.service';
import { FinanceService } from '../finance/finance.service';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { round } from '../common/number.util';
import { effectiveReturnStatus } from '../common/return-status.util';
import { availableStock, AVAILABLE_STOCK_EXPR } from '../common/stock-availability.util';
import { releaseRefundCapacity, remainingRefundable, reserveRefundCapacity } from '../common/refund-cap.util';
import { CreateExchangeDto } from './dto/order-exchange.dto';
import { deriveSellerReturnStatus, isExchangeableReturnLine, quoteExchange } from './order-exchange.util';

type Actor = { actorId: string; actorRole: 'seller' | 'staff' };

const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * Shopify EXCHANGES. A return line that is still waiting for a decision can be resolved as an exchange instead of a refund:
 * the customer gets replacement items as a NEW order linked to the original, and only the price difference moves money.
 *
 * Money (Option A — the platform never holds sale money):
 *  - The value of the returned lines (price + their tax share, never more than what is left in the order's shared refund
 *    budget — `common/refund-cap.util.ts`) is taken out of that budget ONCE and credited against the replacement.
 *  - replacement costs MORE: the exchange order is created UNPAID as a cash-on-delivery style order for the difference only;
 *    the seller collects it themselves (on delivery / "Record payment"). Nothing is charged on the platform Stripe account and
 *    nothing is credited to a platform-held balance.
 *  - replacement costs LESS: the difference is refunded through the existing refund primitives — to the original payment
 *    method (Stripe refund + ledger reversal, exactly like a return refund) or to store credit — and the exchange order is
 *    fully covered by the credit (total 0, paymentType `store_credit`).
 *  - even exchange: no money moves.
 * The exchange order only carries NEW money (lines are scaled down by the credit), so revenue, the ledger and later
 * cancel/refund caps on it are never double counted against the original order.
 * Only PAID orders can be exchanged (the credit must be real money) and orders paid with a gift card / store credit are refused
 * (that discount would have to be re-split and restored).
 */
@Injectable()
export class OrderExchangeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly notifications: NotificationsService,
    private readonly exchangeRate: ExchangeRateService,
    private readonly paymentService: PaymentService,
    private readonly finance: FinanceService,
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

  private async timeline(orderId: string, type: string, message: string, actor: Actor | null) {
    try { await this.r.orderModel.updateOne({ _id: orderId }, { $push: { timeline: this.entry(type, message, actor) } }); } catch { /* informational */ }
  }

  async createExchange(sellerId: string, storeId: string, orderId: string, actor: Actor, dto: CreateExchangeDto) {
    const { store, order, soIndex } = await this.loadOwned(sellerId, storeId, orderId);

    if (['cancelled', 'refunded'].includes(order.orderStatus)) throw new BadRequestException('This order was cancelled or refunded — it cannot be exchanged');
    if (!order.isPaid) throw new BadRequestException('Only paid orders can be exchanged — record the payment first (the returned items are credited against the replacement).');
    if ((order.giftCardDiscountTotal ?? 0) > 0 || (order.storeCreditDiscountTotal ?? 0) > 0) {
      throw new BadRequestException('Orders paid (even partly) with a gift card or store credit cannot be exchanged — approve the return as a refund and create a new order instead.');
    }

    const plain: any = order.toObject();
    const so = plain.sellerOrders[soIndex];

    // ── 1) the return lines being exchanged ──
    const returnIds = [...new Set(dto.returnItemIds)];
    const lineIdx: number[] = [];
    let wanted = 0;
    for (const id of returnIds) {
      const i = (so.items as any[]).findIndex((it: any) => String(it._id) === id);
      if (i === -1) throw new BadRequestException('Return item not found on this order');
      const item = so.items[i];
      const chk = isExchangeableReturnLine(item);
      if (!chk.ok) throw new BadRequestException(`"${item.name}": ${chk.reason}`);
      lineIdx.push(i);
      wanted += (item.totalPrice ?? 0) + (item.taxUSD ?? 0);
    }
    wanted = round(wanted);

    // ── 2) the replacement items (this store, active, physical, in stock) ──
    const merged = new Map<string, number>();
    for (const rp of dto.replacements) merged.set(rp.variantId, (merged.get(rp.variantId) ?? 0) + rp.quantity);
    const repl: Array<{ variant: any; product: any; quantity: number; unit: number }> = [];
    for (const [variantId, quantity] of merged) {
      const variant: any = await this.r.productVariantModel.findOne({ _id: variantId, isDelete: false, status: 'active' }).lean();
      if (!variant) throw new BadRequestException('A replacement product is no longer available');
      const product: any = await this.r.productModel.findOne({ _id: variant.productId, storeId, sellerId, isDelete: false }).lean();
      if (!product || product.status !== 'active') throw new BadRequestException('A replacement product is not an active product of this store');
      if (product.type !== 'physical') throw new BadRequestException('Only physical products can be used as a replacement');
      if (!variant.unlimitedStock && !variant.allowBackorder && availableStock(variant) < quantity) {
        throw new BadRequestException(`Not enough stock for "${product.name}"`);
      }
      const unit = round(this.exchangeRate.convertWithSnapshots(variant.price, store.baseCurrency, order.currency, order.fxSnapshots ?? []));
      repl.push({ variant, product, quantity, unit });
    }

    const effTaxRate = so.subtotal > 0 ? (so.taxAmount ?? 0) / so.subtotal : 0;
    const previewCredit = Math.min(wanted, remainingRefundable(order.sellerOrders[soIndex]));
    const preview = quoteExchange(repl.map((x) => ({ unitPrice: x.unit, quantity: x.quantity })), effTaxRate, previewCredit);
    const summarise = (q: ReturnType<typeof quoteExchange>) => ({
      currency: order.currency,
      returnedValue: wanted,
      credit: q.credit,
      creditShortfall: round(wanted - q.credit),
      replacementSubtotal: q.replacementSubtotal,
      replacementTax: q.replacementTax,
      replacementValue: q.replacementValue,
      difference: q.difference,
      amountDue: q.amountDue,
      refundDue: q.refundDue,
      outcome: q.difference > 0 ? 'charge' : q.difference < 0 ? 'refund' : 'even',
      lines: repl.map((x, k) => ({ variantId: String(x.variant._id), name: x.product.name, quantity: x.quantity, unitPrice: x.unit, total: q.lines[k].gross })),
    });
    if (dto.dryRun) return { success: true, message: 'Preview', data: summarise(preview) };
    if (previewCredit <= 0) throw new BadRequestException('Nothing is left to credit on this order (it was already refunded) — create a new order instead.');

    // ── 3) reserve replacement stock (atomic; rolled back on any later failure) ──
    const applied: Array<{ variantId: string; qty: number }> = [];
    const rollbackStock = async () => {
      for (const m of applied) {
        await this.r.productVariantModel.updateOne({ _id: m.variantId }, [{ $set: { committedStock: { $max: [0, { $subtract: ['$committedStock', m.qty] }] } } }]).catch(() => undefined);
      }
    };
    try {
      for (const x of repl) {
        const id = String(x.variant._id);
        if (x.variant.unlimitedStock || x.variant.allowBackorder) {
          await this.r.productVariantModel.updateOne({ _id: id }, { $inc: { committedStock: x.quantity } });
        } else {
          const res: any = await this.r.productVariantModel.updateOne(
            { _id: id, isDelete: false, $expr: { $gte: [AVAILABLE_STOCK_EXPR, x.quantity] } },
            { $inc: { committedStock: x.quantity } },
          );
          if ((res.modifiedCount ?? res.nModified ?? 0) === 0) throw new BadRequestException(`Not enough stock for "${x.product.name}"`);
        }
        applied.push({ variantId: id, qty: x.quantity });
      }
    } catch (err) {
      await rollbackStock();
      throw err;
    }

    // ── 4) take the credit out of the ONE shared refund budget, then claim the return lines atomically ──
    let granted = 0;
    try {
      granted = await reserveRefundCapacity(this.r.orderModel, orderId, soIndex, wanted, { clamp: true });
    } catch (err) {
      await rollbackStock();
      throw err;
    }
    if (granted <= 0) { await rollbackStock(); throw new BadRequestException('Nothing is left to credit on this order — create a new order instead.'); }
    const giveBack = () => releaseRefundCapacity(this.r.orderModel, orderId, soIndex, granted).catch(() => undefined);

    const quote = quoteExchange(repl.map((x) => ({ unitPrice: x.unit, quantity: x.quantity })), effTaxRate, granted);
    const newId = new Types.ObjectId();
    const newNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;

    const prefix = `sellerOrders.${soIndex}.items`;
    const filter: any = { _id: order._id };
    const set: any = {};
    const prevItems = lineIdx.map((i) => ({ i, refundedAmount: so.items[i].refundedAmount ?? 0, returnStatus: so.items[i].returnStatus as string }));
    for (const i of lineIdx) {
      const it = so.items[i];
      const share = wanted > 0 ? round(granted * (((it.totalPrice ?? 0) + (it.taxUSD ?? 0)) / wanted)) : 0;
      // Open return lines only (requested / approved / received); the claim fails if someone else resolved it meanwhile.
      filter[`${prefix}.${i}.returnStatus`] = { $in: ['requested', 'approved', 'received'] };
      filter[`${prefix}.${i}.exchangeOrderId`] = { $in: [null] };
      set[`${prefix}.${i}.returnStatus`] = 'exchanged';
      set[`${prefix}.${i}.returnResolvedAt`] = new Date();
      set[`${prefix}.${i}.returnResolution`] = 'exchange';
      set[`${prefix}.${i}.exchangeOrderId`] = String(newId);
      set[`${prefix}.${i}.exchangeOrderNumber`] = newNumber;
      set[`${prefix}.${i}.refundedAmount`] = share;
    }
    const prevSoReturnStatus = so.returnStatus ?? 'none';
    const statuses = (so.items as any[])
      .filter((it: any) => it.type === 'physical' && it.status !== 'cancelled')
      .map((it: any) => (lineIdx.includes(so.items.indexOf(it)) ? 'exchanged' : effectiveReturnStatus(it)));
    set[`sellerOrders.${soIndex}.returnStatus`] = deriveSellerReturnStatus(statuses);
    set.hasReturnApproved = true;
    const claimed: any = await this.r.orderModel.updateOne(filter, { $set: set });
    if ((claimed.modifiedCount ?? claimed.nModified ?? 0) === 0) {
      await giveBack();
      await rollbackStock();
      throw new ConflictException('These return items were just handled by someone else — refresh and try again.');
    }
    const unclaim = async () => {
      const undo: any = {};
      for (const p of prevItems) {
        undo[`${prefix}.${p.i}.returnStatus`] = p.returnStatus;
        undo[`${prefix}.${p.i}.returnResolvedAt`] = null;
        undo[`${prefix}.${p.i}.returnResolution`] = null;
        undo[`${prefix}.${p.i}.exchangeOrderId`] = null;
        undo[`${prefix}.${p.i}.exchangeOrderNumber`] = null;
        undo[`${prefix}.${p.i}.refundedAmount`] = p.refundedAmount;
      }
      undo[`sellerOrders.${soIndex}.returnStatus`] = prevSoReturnStatus;
      if (!order.hasReturnApproved) undo.hasReturnApproved = false;
      await this.r.orderModel.updateOne({ _id: order._id }, { $set: undo }).catch(() => undefined);
    };

    // ── 5) the exchange order ──
    const settleCur: string | null = so.settlementCurrency ?? null;
    const items = repl.map((x, k) => {
      const q = quote.lines[k];
      return {
        _id: new Types.ObjectId(), productId: String(x.product._id), variantId: String(x.variant._id), type: 'physical',
        productType: x.product.productType ?? null, name: x.product.name, image: x.variant.images?.[0] ?? x.product.images?.[0] ?? null,
        sku: x.variant.sku ?? null, options: x.variant.options ?? [], licenseType: null, quantity: x.quantity,
        price: x.unit, totalPrice: q.netTotal, originalPrice: x.unit,
        subscriberDiscountUSD: 0, couponDiscountUSD: 0, giftCardDiscountUSD: 0, storeCreditDiscountUSD: 0,
        campaignId: null, campaignDiscountUSD: 0, campaignSponsorType: null, autoDiscountId: null, autoDiscountUSD: 0,
        taxUSD: q.netTax, isBackordered: false, status: 'pending', refundedAmount: 0, downloadCount: 0, returnStatus: 'none',
      };
    });
    const subtotal = round(items.reduce((s, it) => s + it.totalPrice, 0));
    const taxAmount = round(items.reduce((s, it) => s + it.taxUSD, 0));
    const totalAmount = round(subtotal + taxAmount);
    const owes = totalAmount > 0;
    const exchangeOf = { orderId: String(order._id), orderNumber: order.orderNumber, itemIds: returnIds };
    try {
      await this.r.orderModel.create({
        _id: newId,
        orderNumber: newNumber,
        userId: order.userId,
        customerId: order.customerId ?? null,
        checkoutId: `exchange-${String(order._id)}-${String(newId)}`,
        currency: order.currency,
        fxSnapshots: plain.fxSnapshots ?? [],
        ratePerUSD: order.ratePerUSD ?? null,
        sellerOrders: [{
          sellerId, storeId, fulfillmentType: 'physical', items, subtotal, taxAmount,
          settlementCurrency: settleCur,
          settlementAmount: settleCur ? round(this.exchangeRate.convertWithSnapshots(totalAmount, order.currency, settleCur, order.fxSnapshots ?? [])) : null,
          settledViaConnect: false, stripeConnectedAccountId: null, status: 'pending',
        }],
        shippingAddress: plain.shippingAddress ?? null,
        fulfillmentMethod: order.fulfillmentMethod ?? 'ship',
        pickupLocation: plain.pickupLocation ?? null,
        subtotal, shippingFee: 0, taxAmount, totalAmount,
        paymentType: owes ? 'cash_on_delivery' : 'store_credit',
        paymentStatus: owes ? 'unpaid' : 'paid',
        isPaid: !owes,
        paidAt: owes ? null : new Date(),
        orderStatus: 'pending',
        attributionSource: 'other',
        exchangeOf,
        timeline: [this.entry('placed', `Exchange order for #${order.orderNumber}${owes ? ` — ${totalAmount.toFixed(2)} ${order.currency} still to be collected from the customer` : ' — covered by the returned items'}`, actor)],
        isDelete: false,
      });
    } catch (err) {
      await unclaim();
      await giveBack();
      await rollbackStock();
      throw err;
    }
    for (const x of repl) {
      await this.r.productModel.updateOne({ _id: x.product._id }, { $inc: { purchaseCount: x.quantity } }).catch(() => undefined);
    }

    // ── 6) money: refund the difference when the replacement is cheaper ──
    let refundNote = '';
    if (quote.refundDue > 0) {
      const refundDue = quote.refundDue;
      try {
        if (dto.refundTo === 'store_credit') {
          const credit = round(this.exchangeRate.convertWithSnapshots(refundDue, order.currency, store.baseCurrency, order.fxSnapshots ?? []));
          await this.storeCredit.creditFromRefund(storeId, order.userId, credit, String(order._id), `exchange:${String(newId)}`, `Order #${order.orderNumber} — exchange difference`, { actorId: actor.actorId, actorRole: 'seller' } as any);
          refundNote = `Exchange difference of ${refundDue.toFixed(2)} ${order.currency} refunded to store credit`;
        } else {
          const settlementCurrency = so.settlementCurrency ?? order.currency ?? 'USD';
          try {
            await this.finance.recordRefund(
              storeId, sellerId, String(order._id),
              this.exchangeRate.convertWithSnapshots(refundDue, order.currency, settlementCurrency, order.fxSnapshots ?? []),
              actor.actorId, 'seller',
              { description: `Exchange difference — Order #${order.orderNumber}`, targetType: 'order', currency: settlementCurrency },
            );
          } catch (e: any) {
            await this.activityLog.log({
              storeId, category: 'finance', action: 'exchange_ledger_reversal_failed',
              description: `Exchange on order #${order.orderNumber}: the ledger reversal of ${refundDue.toFixed(2)} ${order.currency} failed: ${e?.message}`,
              actorId: actor.actorId, actorRole: actor.actorRole, isSecurityAlert: true, targetId: String(order._id), targetType: 'order',
            });
          }
          if (order.paymentType === 'stripe') {
            const txn: any = await this.r.paymentTransactionModel.findOne({ orderIds: String(order._id), status: 'completed', isDelete: false });
            if (!txn?.stripePaymentIntentId) throw new Error('No completed Stripe payment found for this order');
            await this.paymentService.refundStripePaymentIntent(txn.stripePaymentIntentId, refundDue, `exchange_${String(newId)}`);
            refundNote = `Exchange difference of ${refundDue.toFixed(2)} ${order.currency} refunded to the original payment method`;
          } else {
            refundNote = `Exchange difference of ${refundDue.toFixed(2)} ${order.currency} was paid outside the platform — refund it to the customer manually`;
          }
        }
      } catch (err: any) {
        refundNote = `REFUND FAILED (${err?.message}) — refund ${refundDue.toFixed(2)} ${order.currency} to the customer manually`;
        await this.activityLog.log({
          storeId, category: 'finance', action: 'exchange_refund_failed',
          description: `Exchange on order #${order.orderNumber}: refund of ${refundDue.toFixed(2)} ${order.currency} failed: ${err?.message}`,
          actorId: actor.actorId, actorRole: actor.actorRole, isSecurityAlert: true, targetId: String(order._id), targetType: 'order',
        });
      }
    }

    // ── 7) returned units back on the shelf (opt-in, like return approval) ──
    if (dto.restock === 'restock' || dto.restock === 'damaged') {
      try {
        const seller: any = await this.r.sellerModel.findOne({ _id: sellerId }).select('name');
        for (const i of lineIdx) {
          const it = so.items[i];
          if (!it.variantId || it.returnStatus === 'received') continue; // received lines were restocked (or not) when marked received
          const variant: any = await this.r.productVariantModel.findOne({ _id: it.variantId, isDelete: false });
          if (!variant || variant.unlimitedStock) continue;
          await this.r.productVariantModel.updateOne({ _id: it.variantId }, dto.restock === 'restock' ? { $inc: { stock: it.quantity } } : { $inc: { stock: it.quantity, damagedStock: it.quantity } });
          await this.r.stockAdjustmentModel.create({
            storeId, productId: it.productId, variantId: it.variantId, locationId: null,
            productName: it.name, sku: it.sku ?? null,
            previousStock: variant.stock, newStock: variant.stock + it.quantity, delta: it.quantity,
            reason: dto.restock === 'restock' ? 'return' : 'damaged',
            note: `Exchange return for order #${order.orderNumber}`,
            adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
          });
        }
      } catch { /* stock bookkeeping must not undo a completed exchange */ }
    }

    // ── 8) timelines, activity log, buyer notification ──
    const returnedNames = lineIdx.map((i) => so.items[i].name).join(', ');
    const outcomeText = quote.difference > 0
      ? `Customer owes ${quote.amountDue.toFixed(2)} ${order.currency} (collected by the store)`
      : quote.difference < 0 ? (refundNote || `${quote.refundDue.toFixed(2)} ${order.currency} refunded`) : 'Even exchange — no payment due';
    await this.timeline(String(order._id), 'exchange', `Exchange created: ${returnedNames} → order #${newNumber}. ${outcomeText}`, actor);
    if (dto.note?.trim()) await this.timeline(String(newId), 'comment', dto.note.trim().slice(0, 300), actor);
    await this.activityLog.log({
      storeId, category: 'orders', action: 'exchange_created',
      description: `Exchange for order #${order.orderNumber}: ${returnedNames} → order #${newNumber}. ${outcomeText}`,
      actorId: actor.actorId, actorRole: actor.actorRole, targetId: String(order._id), targetType: 'order',
    });
    const buyerBody = `Your exchange for order #${order.orderNumber} was approved. Your replacement is order #${newNumber}.`
      + (quote.amountDue > 0 ? ` The price difference of ${quote.amountDue.toFixed(2)} ${order.currency} will be collected by the store.` : '')
      + (quote.refundDue > 0 && !refundNote.startsWith('REFUND FAILED') ? ` ${quote.refundDue.toFixed(2)} ${order.currency} is being refunded to you.` : '');
    this.notifications.notify({
      recipientId: String(order.userId), recipientRole: 'user', type: NOTIFICATION_TYPES.ORDER_UPDATED, storeId,
      title: 'Your exchange was approved', body: buyerBody, data: { orderId: String(newId) },
      email: {
        subject: `Your exchange for order #${order.orderNumber}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Exchange approved</h2><p>${esc(buyerBody)}</p><p style="color:#888;font-size:12px">${esc(store.name ?? '')}</p></div>`,
      },
    } as any).catch(() => undefined);

    return {
      success: true,
      message: 'Exchange created',
      data: { ...summarise(quote), exchangeOrderId: String(newId), exchangeOrderNumber: newNumber, refundNote },
    };
  }
}
