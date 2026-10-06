import { Optional } from '@nestjs/common';
import { ShippingProfilesService } from '@/shipping-zones/shipping-profiles.service';
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { isValidObjectId, Types } from 'mongoose';
import { reserveRefundCapacity, releaseRefundCapacity } from '@/common/refund-cap.util';
import { buyerEmail } from '@/common/buyer-email.util';
import { toBuyerReturnLabel, toBuyerSafeOrder, toBuyerTracking } from '@/common/buyer-safe-order.util';
import { signOrderStatusToken, verifyOrderStatusToken } from '@/common/order-status-token.util';
import { DatabaseService } from '@/database/databaseservice';
import { UploadService } from '@/upload/upload.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FinanceService } from '@/finance/finance.service';
import { PaymentService } from '@/payment/payment.service';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { LoyaltyService } from '@/loyalty/loyalty.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { ShippingRatesService } from '@/shipping-rates/shipping-rates.service';
import type { CustomsLine } from '@/shipping-rates/customs.util';
import { fulfilStockForSellerOrders } from '@/common/fulfil-stock.util';
import { StoreCreditService } from '@/store-credit/store-credit.service';
import { GiftCardsService } from '@/gift-cards/gift-cards.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { round } from '@/common/number.util';
import { buildDiffMetadata } from '@/common/activity-diff.util';
import { deriveRollupStatus , isAllowedSellerOrderTransition } from './order-status.util';
import { toCsv } from '@/analytics/utils/csv.util';
import { FulfilOrderDto } from './dto/fulfil-order.dto';
import {
  cleanTrackingInput, isFullyShipped, isShippableItem, shippedQtyByItem, unshippedLines, validateFulfilRequest, validateReturnLabelItems, FulfilLine,
} from './shipments.util';
import { buildDeliveredEmail, buildReadyForPickupEmail, buildReturnLabelEmail, buildShippedEmail } from './shipping-email.util';

/** A sellerOrder's true payout basis for FinanceService.recordSale, in the
 *  SELLER'S OWN currency (so.settlementCurrency) — independent of what
 *  currency the buyer actually paid in (order.currency). Computed once at
 *  order-creation time (PaymentService.createOrder) already restoring the
 *  platform-sponsored portion of any campaign discount on top of the
 *  (already net-of-discount) native subtotal, so a platform-sponsored sale
 *  never reduces what the seller is credited. Falls back to the old
 *  order-currency-denominated calculation only for orders placed before
 *  settlementAmount/settlementCurrency existed. */
function sellerPayoutBasis(so: any): number {
  if (so.settlementAmount != null) return so.settlementAmount;
  return round(so.subtotal + (so.platformSponsoredDiscountUSD ?? 0) + (so.taxAmount ?? 0));
}

function sellerPayoutCurrency(so: any, order: any): string {
  return so.settlementCurrency ?? order.currency ?? 'USD';
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly financeService: FinanceService,
    private readonly paymentService: PaymentService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly activityLogService: ActivityLogService,
    private readonly loyaltyService: LoyaltyService,
    private readonly notificationsService: NotificationsService,
    private readonly shippingRatesService: ShippingRatesService,
    private readonly giftCardsService: GiftCardsService,
    private readonly storeCreditService: StoreCreditService,
    // Optional: only used to ship labels from the product's shipping-profile origin location.
    @Optional() private readonly shippingProfilesService?: ShippingProfilesService,
  ) {}

  /** Awards loyalty points for a completed order (the store's own loyalty program rate). */
  private async awardLoyaltyPoints(
    storeId: string,
    userId: string,
    orderId: string,
    subtotal: number,
  ) {
    return this.loyaltyService.awardPurchasePoints(storeId, userId, orderId, subtotal);
  }

  /** Appends an event to the order's merchant timeline (best-effort, never blocks the action). */
  private async pushTimeline(orderId: string, type: string, message: string, actorId: string | null, actorRole: string | null) {
    try {
      await this.databaseService.repositories.orderModel.updateOne(
        { _id: orderId },
        { $push: { timeline: { type, message, actorId, actorRole: actorRole ?? 'system', createdAt: new Date() } } },
      );
    } catch { /* informational */ }
  }

  async getOrdersByUserId(userId: string, query: any, storeId: string) {
    const { orderModel, sellerModel, ratingModel } =
      this.databaseService.repositories;

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 10;
    const skip = (page - 1) * limit;

    // Scoped to this one store's app build — an order predating the
    // single-store conversion (or one placed by a legacy cross-store
    // account) may touch more than one store, but this build must never
    // surface another store's segment of it. `sellerOrders.storeId` matches
    // the same filter shape `getSellerOrders` already uses.
    const filter: any = { userId, isDelete: false, 'sellerOrders.storeId': storeId };

    if (query.status && query.status !== 'all') {
      filter.orderStatus = query.status;
    }

    const total = await orderModel.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const orders = await orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Batch-resolve seller name + verification badge across every distinct
    // seller in this page — same one-query-instead-of-N pattern used on the
    // product listing endpoints.
    const sellerIds = [
      ...new Set(
        orders.flatMap((order: any) =>
          (order.sellerOrders ?? []).map((so: any) => so.sellerId),
        ),
      ),
    ].filter(Boolean);
    const sellers = sellerIds.length
      ? await sellerModel
          .find({ _id: { $in: sellerIds } })
          .select('name isVerified')
          .lean()
      : [];
    const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));

    // Batch-resolve which products this buyer already reviewed, across every
    // product in this page, so each item can be flagged `isReviewed` without
    // a query per item.
    const productIds = [
      ...new Set(
        orders.flatMap((order: any) =>
          (order.sellerOrders ?? []).flatMap((so: any) =>
            (so.items ?? []).map((item: any) => item.productId),
          ),
        ),
      ),
    ].filter(Boolean);
    const reviewedProductIds = productIds.length
      ? new Set(
          (
            await ratingModel
              .find({ userId, productId: { $in: productIds }, isDelete: false })
              .select('productId')
              .lean()
          ).map((r: any) => r.productId),
        )
      : new Set();

    const list = orders.map((order: any) => ({
      orderId: order._id,
      orderNumber: order.orderNumber,
      orderStatus: order.orderStatus,
      paymentType: order.paymentType,
      paymentStatus: order.paymentStatus,
      isPaid: order.isPaid,
      subtotal: order.subtotal,
      shippingFee: order.shippingFee,
      taxAmount: order.taxAmount,
      subscriberDiscountTotal: order.subscriberDiscountTotal ?? 0,
      totalAmount: order.totalAmount,
      currency: order.currency,
      shippingAddress: order.shippingAddress,
      fulfillmentMethod: order.fulfillmentMethod ?? 'ship',
      pickupLocation: order.pickupLocation ?? null,
      exchangeOf: order.exchangeOf ?? null,
      stores: (order.sellerOrders ?? [])
        .filter((so: any) => so.storeId === storeId)
        .map((so: any) => {
        const seller = sellerMap.get(so.sellerId?.toString());
        return {
          storeId: so.storeId,
          sellerOrderId: so._id,
          sellerId: so.sellerId,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          fulfillmentType: so.fulfillmentType,
          status: so.status,
          subtotal: so.subtotal,
          itemCount: (so.items ?? []).length,
          items: (so.items ?? []).map((item: any) => ({
            itemId: item._id,
            productId: item.productId,
            name: item.name,
            image: item.image,
            sku: item.sku,
            type: item.type,
            productType: item.productType ?? null,
            quantity: item.quantity,
            price: item.price,
            totalPrice: item.totalPrice,
            originalPrice: item.originalPrice ?? null,
            subscriberDiscountUSD: item.subscriberDiscountUSD ?? 0,
            status: item.status,
            returnStatus: item.returnStatus ?? 'none', exchangeOrderId: item.exchangeOrderId ?? null, exchangeOrderNumber: item.exchangeOrderNumber ?? null,
            // Prepaid return label (link + tracking only, never its cost) — this buyer's own order only.
            returnLabel: toBuyerReturnLabel(item.returnLabel),
            isReviewed: reviewedProductIds.has(item.productId),
          })),
          tracking: toBuyerTracking(so.tracking),
          shipments: (so.shipments ?? []).map((sh: any) => ({
            _id: sh._id,
            items: sh.items ?? [],
            tracking: toBuyerTracking(sh.tracking),
            shippedAt: sh.shippedAt ?? null,
            deliveredAt: sh.deliveredAt ?? null,
          })),
          pickupReadyAt: so.pickupReadyAt ?? null,
          shippedAt: so.shippedAt,
          deliveredAt: so.deliveredAt,
        };
      }),
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    }));

    return {
      success: true,
      data: {
        pagination: { page, limit, totalPages, total },
        orders: list,
      },
    };
  }

  async getOrderById(userId: string, orderId: string, storeId: string) {
    const { orderModel, sellerModel } = this.databaseService.repositories;

    const order = await orderModel
      .findOne({ _id: orderId, isDelete: false })
      .lean();
    if (!order) throw new NotFoundException('Order not found');
    if ((order as any).userId !== userId)
      throw new ForbiddenException('Unauthorized');

    // Same reasoning as getOrdersByUserId — never surface another store's
    // segment of an order that happens to touch more than one store. If
    // this order doesn't touch this build's store at all, treat it as not
    // found rather than exposing that it exists elsewhere.
    const orderSellerOrders = (
      ((order as any).sellerOrders ?? []) as any[]
    ).filter((so: any) => so.storeId === storeId);
    if (orderSellerOrders.length === 0) {
      throw new NotFoundException('Order not found');
    }
    const sellerIds: string[] = [
      ...new Set(orderSellerOrders.map((so: any) => so.sellerId)),
    ].filter(Boolean);
    const sellers = sellerIds.length
      ? await sellerModel
          .find({ _id: { $in: sellerIds } })
          .select('name isVerified')
          .lean()
      : [];
    const sellerMap = new Map(sellers.map((s: any) => [s._id.toString(), s]));

    const enrichedOrder = {
      ...order,
      sellerOrders: orderSellerOrders.map((so: any) => {
        const seller = sellerMap.get(so.sellerId?.toString());
        return {
          ...so,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
        };
      }),
    };

    return {
      success: true,
      data: toBuyerSafeOrder(enrichedOrder),
    };
  }

  /** Shopify order-status page: opens ONE order from a signed link, no login (how a guest tracks an order). */
  async getOrderByStatusToken(token: string) {
    const orderId = verifyOrderStatusToken(token);
    if (!orderId || !isValidObjectId(orderId)) throw new NotFoundException('Order not found');
    const { orderModel, sellerModel } = this.databaseService.repositories;
    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false }).lean();
    if (!order) throw new NotFoundException('Order not found');
    const sellerIds = [...new Set((order.sellerOrders ?? []).map((so: any) => String(so.sellerId)))].filter(Boolean) as string[];
    const sellers = sellerIds.length ? await sellerModel.find({ _id: { $in: sellerIds } }).select('name').lean() : [];
    const nameById = new Map(sellers.map((x: any) => [String(x._id), x.name]));
    const enriched = { ...order, sellerOrders: (order.sellerOrders ?? []).map((so: any) => ({ ...so, sellerName: nameById.get(String(so.sellerId)) ?? null })) };
    return { success: true, data: toBuyerSafeOrder(enriched) };
  }

  /** A signed status-page link token for an order the caller owns. */
  async getOrderStatusToken(userId: string, orderId: string) {
    const { orderModel } = this.databaseService.repositories;
    const order: any = await orderModel.findOne({ _id: orderId, userId, isDelete: false }).select('_id').lean();
    if (!order) throw new NotFoundException('Order not found');
    return { success: true, data: { token: signOrderStatusToken(String(order._id)) } };
  }

  /** `storeId` omitted (null) means "every store this seller owns" — used by the
   *  seller-wide dashboard, as opposed to a single store's own orders page. */
  async getSellerOrders(sellerId: string, storeId: string | null, query: any) {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;

    let storeIds: string[];
    if (storeId) {
      const store = await storeModel.findOne({
        _id: storeId,
        sellerId,
        isDelete: false,
      });
      if (!store)
        throw new ForbiddenException('Store not found or unauthorized');
      storeIds = [storeId];
    } else {
      const stores = await storeModel
        .find({ sellerId, isDelete: false })
        .select('_id')
        .lean();
      storeIds = stores.map((s: any) => s._id.toString());
    }

    const page = parseInt(query.page) || 1;
    const limit = Math.min(50, parseInt(query.limit) || 10);
    const skip = (page - 1) * limit;

    // base filter — orders touching any of the scoped store(s)
    const matchFilter: any = {
      'sellerOrders.storeId': { $in: storeIds },
      isDelete: false,
    };

    // Scope to one buyer's own order history within this store — reuses the
    // exact same aggregation/pagination/stats logic below rather than a
    // separate customer-order-history endpoint.
    // (`userId` here is the CUSTOMER id — for guests that is the canonical customer, so all of their sessions show.)
    const andClauses: any[] = [];
    if (query.userId) {
      andClauses.push({ $or: [{ userId: String(query.userId) }, { customerId: String(query.userId) }] });
    }

    // status / type must hold on THIS store's sub-order (one element), not on any element of a multi-store order.
    const subFilter: any = { storeId: { $in: storeIds } };
    if (query.type && query.type !== 'all') subFilter.fulfillmentType = String(query.type);
    if (query.status && query.status !== 'all') subFilter.status = String(query.status);
    if (Object.keys(subFilter).length > 1) matchFilter.sellerOrders = { $elemMatch: subFilter };

    if (query.time && query.time !== 'all') {
      const now = new Date();
      if (query.time === 'today') {
        matchFilter.createdAt = { $gte: new Date(now.setHours(0, 0, 0, 0)) };
      } else if (query.time === 'week') {
        const week = new Date();
        week.setDate(week.getDate() - 7);
        matchFilter.createdAt = { $gte: week };
      } else if (query.time === 'month') {
        const month = new Date();
        month.setMonth(month.getMonth() - 1);
        matchFilter.createdAt = { $gte: month };
      }
    }

    // Server-side search over the WHOLE order history: order number, product name, customer name/email.
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const users = await userModel
        .find({ $or: [{ name: re }, { email: re }], storeId: { $in: [...storeIds, null] } })
        .select('_id')
        .limit(200)
        .lean();
      andClauses.push({
        $or: [
          { orderNumber: re },
          { 'sellerOrders.items.name': re },
          ...(users.length ? [{ userId: { $in: users.map((u: any) => String(u._id)) } }] : []),
        ],
      });
    }
    if (andClauses.length) matchFilter.$and = andClauses;

    const totalOrders = await orderModel.countDocuments(matchFilter);
    const totalPages = Math.ceil(totalOrders / limit);

    const orders = await orderModel
      .find(matchFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // stats — all orders across the scoped store(s), unfiltered and unpaginated, computed in the database
    // (no longer loads every order document into memory just to add up three numbers).
    const [statRow]: any[] = await orderModel.aggregate([
      { $match: { 'sellerOrders.storeId': { $in: storeIds }, isDelete: false } },
      { $addFields: { so: { $first: { $filter: { input: '$sellerOrders', as: 's', cond: { $in: ['$$s.storeId', storeIds] } } } } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $in: ['$so.status', ['completed', 'delivered']] }, { $ifNull: ['$so.subtotal', 0] }, 0] } },
          pending: { $sum: { $cond: [{ $in: ['$so.status', ['pending', 'processing']] }, 1, 0] }, },
        },
      },
    ]);
    const totalRevenue: number = statRow?.revenue ?? 0;
    const pendingCount: number = statRow?.pending ?? 0;
    const allOrdersCount: number = statRow?.count ?? 0;
    const avgOrder = allOrdersCount > 0 ? totalRevenue / allOrdersCount : 0;

    // order rows format
    const rows = await Promise.all(
      orders.map(async (order: any) => {
        const so = order.sellerOrders.find((s: any) =>
          storeIds.includes(s.storeId),
        );
        if (!so) return null;

        const user = await userModel
          .findOne({ _id: order.userId })
          .select('name email contactEmail isGuest')
          .lean();
        const firstItem = so.items?.[0];

        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: buyerEmail(user as any) || '',
          },
          product: firstItem?.name || '',
          type: so.fulfillmentType,
          productType: firstItem?.productType ?? null,
          date: order.createdAt,
          amount: so.subtotal,
          shippingAddress: order.shippingAddress ?? null,
          // `amount` above is so.subtotal, which is denominated in the order's
          // own currency (fixed per store) — carried per-row so a cross-store
          // "my orders" list can label each row correctly even when the
          // seller's stores don't all share one currency.
          currency: order.currency ?? 'USD',
          status: so.status,
          isPaid: order.isPaid,
          paymentType: order.paymentType,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          totalOrders,
          revenue: totalRevenue,
          pending: pendingCount,
          avgOrder: parseFloat(avgOrder.toFixed(2)),
        },
        pagination: {
          page,
          limit,
          totalPages,
          totalOrders,
        },
        orders: rows.filter(Boolean),
      },
    };
  }

  /**
   * The real seller-facing single-order detail view — previously nonexistent:
   * `getOrderById` above is buyer-only (`order.userId !== userId` throws
   * Forbidden for a seller calling it on their own order), and
   * `getSellerOrders`'s rows only ever carry a flattened summary shape (no
   * full item list, no shipping address, no tracking/timeline). Returns
   * exactly this seller's own portion of the order (`sellerOrder`), never
   * another seller's line items on the same multi-store order.
   */
  async getSellerOrderDetail(
    sellerId: string,
    storeId: string,
    orderId: string,
  ) {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel
      .findOne({ _id: orderId, isDelete: false })
      .lean();
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrder = (order.sellerOrders as any[]).find(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (!sellerOrder) throw new ForbiddenException('Unauthorized');

    const buyer = await userModel
      .findOne({ _id: order.userId })
      .select('name email phone')
      .lean();

    return {
      success: true,
      data: {
        orderId: order._id,
        orderNumber: order.orderNumber,
        createdAt: (order as any).createdAt,
        currency: order.currency ?? 'USD',
        paymentType: order.paymentType,
        paymentStatus: order.paymentStatus,
        isPaid: order.isPaid,
        paidAt: order.paidAt,
        shippingAddress: order.shippingAddress ?? null,
        fulfillmentMethod: (order as any).fulfillmentMethod ?? 'ship',
        pickupLocation: (order as any).pickupLocation ?? null,
        // Set when this order is the replacement order of an exchange (link back to the original).
        exchangeOf: (order as any).exchangeOf ?? null,
        buyer: {
          name: (buyer as any)?.name ?? 'Unknown',
          email: (buyer as any)?.email ?? '',
          phone: (buyer as any)?.phone ?? '',
        },
        // This store's own portion only — items, rollup status, tracking,
        // fulfillment timestamps, return status. `subtotal` here is already
        // scoped to this seller, unlike `order.subtotal` (the whole order).
        sellerOrder,
        // Merchant-only: the Shopify order timeline (events + comments) and the internal note.
        timeline: [...((order as any).timeline ?? [])].sort((a: any, b: any) => +new Date(b.createdAt) - +new Date(a.createdAt)),
        note: (order as any).note ?? '',
      },
    };
  }

  /**
   * Resolves a store's REAL owning sellerId for an admin caller.
   * `getSellerOrderDetail` does its own ownership check via
   * `storeModel.findOne({_id, sellerId})` — for a seller's own JWT,
   * `actingSellerId(req.user)` already IS that value, but for an admin
   * caller it's the admin's own userId, which never matches any store's
   * real `sellerId`. Resolving the real sellerId here and passing THAT
   * into the exact same method is the same pattern already used for
   * `SellerPlatformSubscriptionsService.getSellerOverview` — not a bypass
   * flag threaded through the shared, security-sensitive ownership check
   * itself. Deliberately only backs `adminGetSellerOrderDetail` (a read) —
   * no admin cancel/refund equivalent exists: Solvexo stores are
   * independent (Shopify-style), a seller's own order data is theirs to
   * act on, never admin's to touch on their behalf.
   */
  private async resolveStoreSellerId(storeId: string): Promise<string> {
    if (!isValidObjectId(storeId)) throw new BadRequestException('A valid storeId is required');
    const store = await this.databaseService.repositories.storeModel
      .findOne({ _id: storeId, isDelete: false })
      .select('sellerId')
      .lean();
    if (!store) throw new NotFoundException('Store not found');
    return (store as any).sellerId;
  }

  /** Admin READ-ONLY equivalent of `getSellerOrderDetail` — for the Clients workspace's Orders tab. */
  async adminGetSellerOrderDetail(storeId: string, orderId: string) {
    const sellerId = await this.resolveStoreSellerId(storeId);
    const result = await this.getSellerOrderDetail(sellerId, storeId, orderId);

    // Admin sees USD only: convert a non-USD order with the rate captured on
    // the order itself (Order.ratePerUSD) - never today's rate, never a guess.
    const { orderModel } = this.databaseService.repositories;
    const order: any = await orderModel.findById(orderId).select('ratePerUSD currency').lean();
    const currency = order?.currency ?? 'USD';
    if (currency === 'USD') return result;

    const rate = order?.ratePerUSD;
    const usable = typeof rate === 'number' && rate > 0;
    const conv = (n: any) => (usable && typeof n === 'number' ? Math.round((n / rate) * 100) / 100 : null);
    const so: any = result.data.sellerOrder;
    return {
      ...result,
      data: {
        ...result.data,
        currency: 'USD',
        unconvertible: !usable,
        sellerOrder: {
          ...so,
          subtotal: conv(so.subtotal),
          items: (so.items ?? []).map((it: any) => ({
            ...it,
            price: conv(it.price),
            totalPrice: conv(it.totalPrice),
            refundedAmount: conv(it.refundedAmount ?? 0),
          })),
        },
      },
    };
  }

  /** Same filters as `getSellerOrders` (status/type/time), but no pagination
   *  — capped at 5000 rows (matches AnalyticsService.exportCsv's own cap) so
   *  a seller with an enormous order history can't trigger an unbounded
   *  export. Previously "Export CSV" was a permanently-disabled button with
   *  no backend route behind it at all. */
  async exportOrdersCsv(
    sellerId: string,
    storeId: string | null,
    query: any,
  ): Promise<string> {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;

    let storeIds: string[];
    if (storeId) {
      const store = await storeModel.findOne({
        _id: storeId,
        sellerId,
        isDelete: false,
      });
      if (!store)
        throw new ForbiddenException('Store not found or unauthorized');
      storeIds = [storeId];
    } else {
      const stores = await storeModel
        .find({ sellerId, isDelete: false })
        .select('_id')
        .lean();
      storeIds = stores.map((s: any) => s._id.toString());
    }

    const matchFilter: any = {
      'sellerOrders.storeId': { $in: storeIds },
      isDelete: false,
    };
    if (query.type && query.type !== 'all')
      matchFilter['sellerOrders.fulfillmentType'] = query.type;
    if (query.status && query.status !== 'all')
      matchFilter['sellerOrders.status'] = query.status;
    if (query.time && query.time !== 'all') {
      const now = new Date();
      if (query.time === 'today')
        matchFilter.createdAt = { $gte: new Date(now.setHours(0, 0, 0, 0)) };
      else if (query.time === 'week') {
        const week = new Date();
        week.setDate(week.getDate() - 7);
        matchFilter.createdAt = { $gte: week };
      } else if (query.time === 'month') {
        const month = new Date();
        month.setMonth(month.getMonth() - 1);
        matchFilter.createdAt = { $gte: month };
      }
    }

    const orders = await orderModel
      .find(matchFilter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();
    const userIds = [...new Set(orders.map((o: any) => o.userId))];
    const users = await userModel
      .find({ _id: { $in: userIds } })
      .select('name email contactEmail isGuest')
      .lean();
    const userMap = new Map(users.map((u: any) => [String(u._id), u]));

    const rows: (string | number)[][] = [];
    for (const order of orders as any[]) {
      const so = order.sellerOrders.find((s: any) =>
        storeIds.includes(s.storeId),
      );
      if (!so) continue;
      const user = userMap.get(String(order.userId));
      rows.push([
        order.orderNumber,
        new Date(order.createdAt).toISOString().split('T')[0],
        user?.name ?? 'Unknown',
        user?.email ?? '',
        so.fulfillmentType,
        so.status,
        so.subtotal.toFixed(2),
        order.currency ?? 'USD',
        order.paymentType,
        order.isPaid ? 'Yes' : 'No',
      ]);
    }

    return toCsv(
      [
        'Order Number',
        'Date',
        'Customer',
        'Email',
        'Type',
        'Status',
        'Amount',
        'Currency',
        'Payment Type',
        'Paid',
      ],
      rows,
    );
  }

  async getDownloadUrls(userId: string, orderId: string, productId: string, storeId: string) {
    if (!orderId) throw new BadRequestException('orderId is required');
    if (!productId) throw new BadRequestException('productId is required');

    const { orderModel, productModel } = this.databaseService.repositories;

    // 1. order fetch + ownership
    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');

    // 2. payment check
    if (!order.isPaid) throw new BadRequestException('Order is not paid yet');

    // 3. product is in THIS store's sellerOrder(s) within this order — never
    // let this app's download link resolve to another store's digital item.
    let targetItem: any = null;

    for (const so of order.sellerOrders) {
      if (so.storeId !== storeId) continue;
      for (const item of so.items) {
        if (item.productId === productId) {
          targetItem = item;
          break;
        }
      }
    }

    if (!targetItem)
      throw new BadRequestException('Product not found in this order');
    if (targetItem.type !== 'digital')
      throw new BadRequestException('This is not a digital product');

    // 4. product fetch
    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.digital?.files?.length)
      throw new BadRequestException('No digital files found for this product');

    // 5. link expiry check
    if (product.digital.linkExpiryDays) {
      const paidAt = order.paidAt;
      if (paidAt) {
        const expiryDate = new Date(paidAt);
        expiryDate.setDate(
          expiryDate.getDate() + product.digital.linkExpiryDays,
        );
        if (new Date() > expiryDate) {
          throw new BadRequestException(
            `Download link expired on ${expiryDate.toDateString()}`,
          );
        }
      }
    }

    // 6. download limit check (sirf block karo — count downloadByToken mein increment hoga)
    const downloadLimit = product.digital.downloadLimit;
    if (downloadLimit !== 'unlimited') {
      const limitNum = parseInt(downloadLimit);
      if (targetItem.downloadCount >= limitNum) {
        throw new BadRequestException(
          `Download limit reached (${limitNum}/${limitNum})`,
        );
      }
    }

    // 7. generate tokens for all files
    const files = product.digital.files;
    const isPdfStamping = product.digital.pdfStampingEnabled;

    const result = files.map((file: any, index: number) => {
      const resolvedMimeType = this.uploadService.resolveMimeType(
        file.name,
        file.mimeType ?? 'application/octet-stream',
      );
      const isPdf = resolvedMimeType === 'application/pdf';

      const token = this.jwtService.sign(
        { userId, orderId, productId, fileIndex: index },
        {
          secret: this.configService.get<string>('JWT_SECRET'),
          expiresIn: '10m',
        },
      );

      return {
        index,
        fileName: file.name,
        mimeType: resolvedMimeType,
        size: file.size,
        type: isPdf && isPdfStamping ? 'stamped' : 'download',
        endpoint:
          isPdf && isPdfStamping
            ? '/api/orders/stream-pdf-token'
            : '/api/orders/download-file',
        token,
        expiresIn: '10 minutes',
      };
    });

    const remaining =
      product.digital.downloadLimit === 'unlimited'
        ? 'unlimited'
        : `${parseInt(product.digital.downloadLimit) - (targetItem.downloadCount + 1)} remaining`;

    return {
      success: true,
      message: 'Download links generated',
      data: {
        files: result,
        downloadCount: targetItem.downloadCount + 1,
        downloadLimit: product.digital.downloadLimit,
        remaining,
      },
    };
  }

  /** Total kg of the given lines, from each variant's saved shippingWeight (unparseable/missing = the 0.5 kg default). */
  private async weightKgForLines(lines: { variantId?: string | null; quantity: number }[]): Promise<number> {
    const { productVariantModel } = this.databaseService.repositories;
    const variantIds = [...new Set(lines.map((l) => l.variantId).filter(Boolean) as string[])];
    const variants = variantIds.length ? await productVariantModel.find({ _id: { $in: variantIds } }).select('shippingWeight').lean() : [];
    const weightByVariant = new Map(variants.map((v: any) => [String(v._id), v.shippingWeight]));
    return this.shippingRatesService.computeTotalWeightKg(
      lines.map((l) => ({
        shippingWeight: l.variantId ? weightByVariant.get(l.variantId) ?? null : null,
        quantity: l.quantity ?? 1,
      })),
    );
  }

  /** Shared by label-rate listing + purchase: ownership checks, destination, and real goods weight. */
  private async prepareLabelContext(
    sellerId: string,
    orderId: string,
    storeId: string,
    partialItems?: { itemId: string; quantity: number }[],
  ) {
    const { orderModel, storeModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrderIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (sellerOrderIndex === -1) throw new ForbiddenException('Unauthorized');

    const addr = order.shippingAddress as any;
    if (!addr) throw new BadRequestException('This order has no shipping address on file — it may be digital-only.');
    if (!addr.country) {
      throw new BadRequestException(
        'This order\'s saved address has no country on file (it predates that field) — use the manual tracking-number entry instead.',
      );
    }

    const sellerOrder = order.sellerOrders[sellerOrderIndex] as any;

    // Partial shipment: weigh (and later fulfil) ONLY the selected lines/quantities.
    let partial: { lines: FulfilLine[]; allShipped: boolean } | null = null;
    if (partialItems && partialItems.length > 0) {
      if ((order as any).fulfillmentMethod === 'pickup') {
        throw new BadRequestException('This is a pickup order — mark it ready for pickup instead of shipping it.');
      }
      if (!OrdersService.FULFILLABLE_STATUSES.includes(sellerOrder.status)) {
        throw new BadRequestException(`Cannot buy a label for an order that is "${sellerOrder.status}".`);
      }
      const check = validateFulfilRequest(sellerOrder.items, sellerOrder.shipments ?? [], partialItems);
      if (!check.ok) throw new BadRequestException(check.error);
      partial = { lines: check.lines, allShipped: check.allShipped };
    }

    const totalWeightKg = await this.weightKgForLines(
      partial
        ? partial.lines.map((l) => ({ variantId: sellerOrder.items[l.itemIndex]?.variantId, quantity: l.quantity }))
        : sellerOrder.items.map((item: any) => ({ variantId: item.variantId, quantity: item.quantity ?? 1 })),
    );

    return {
      sellerOrder,
      sellerOrderIndex,
      totalWeightKg,
      partial,
      orderCurrency: ((order as any).currency as string | undefined) || 'USD',
      signerName: ((store as any).name as string | undefined) || 'Seller',
      destination: {
        name: addr.recipientName,
        street1: addr.addressLine1,
        street2: addr.addressLine2 ?? undefined,
        city: addr.city,
        state: addr.state,
        zip: addr.zipCode,
        country: addr.country,
        phone: addr.phoneNumber ?? undefined,
      },
    };
  }

  /** Ship-from address for a label: the shipping profile (of the order's first product that has one) -> its
   *  origin location; null = fall back to the Shippo integration's own origin (unchanged behaviour). */
  private async labelOriginOverride(storeId: string, sellerOrder: any) {
    if (!this.shippingProfilesService) return undefined;
    try {
      const productIds = [...new Set((sellerOrder.items ?? []).map((i: any) => i.productId).filter(Boolean))] as string[];
      let profileId: string | null = null;
      if (productIds.length > 0) {
        const products: any[] = await this.databaseService.repositories.productModel
          .find({ _id: { $in: productIds }, storeId }).select('shippingProfileId').lean();
        profileId = products.find((p) => p.shippingProfileId)?.shippingProfileId ?? null;
      }
      const origin = await this.shippingProfilesService.resolveOrigin(storeId, profileId);
      if (!origin) return undefined;
      const { latitude: _lat, longitude: _lng, locationId: _loc, ...address } = origin as any;
      return address;
    } catch {
      return undefined;
    }
  }

  /** International label only: customs declaration id built from the shipped lines' customs info (country of
   *  origin + HS code per variant). undefined for domestic orders / no Shippo; 400 when a product lacks customs data. */
  private async customsDeclarationForLabel(storeId: string, ctx: any, originOverride: any): Promise<string | undefined> {
    const items: any[] = ctx.partial
      ? ctx.partial.lines.map((l: any) => ({ item: ctx.sellerOrder.items[l.itemIndex], quantity: l.quantity }))
      : (ctx.sellerOrder.items ?? []).map((item: any) => ({ item, quantity: item.quantity ?? 1 }));
    const physical = items.filter((x) => x.item && x.item.type !== 'digital');
    const variantIds = [...new Set(physical.map((x) => x.item.variantId).filter(Boolean))] as string[];
    const variants: any[] = variantIds.length
      ? await this.databaseService.repositories.productVariantModel
        .find({ _id: { $in: variantIds } }).select('shippingWeight countryOfOrigin hsCode customsDescription').lean()
      : [];
    const byId = new Map(variants.map((v: any) => [String(v._id), v]));
    const lines: CustomsLine[] = physical.map((x) => {
      const v: any = x.item.variantId ? byId.get(String(x.item.variantId)) : null;
      const perUnitKg = this.shippingRatesService.computeTotalWeightKg([{ shippingWeight: v?.shippingWeight ?? null, quantity: 1 }]);
      return {
        name: x.item.name,
        quantity: x.quantity,
        value: (Number(x.item.price) || 0) * x.quantity,
        netWeightKg: perUnitKg * x.quantity,
        countryOfOrigin: v?.countryOfOrigin ?? null,
        hsCode: v?.hsCode ?? null,
        customsDescription: v?.customsDescription ?? null,
      };
    });
    const id = await this.shippingRatesService.prepareCustomsDeclaration(storeId, {
      originOverride, destinationCountry: ctx.destination.country, lines, currency: ctx.orderCurrency, signerName: ctx.signerName,
    });
    return id ?? undefined;
  }

  /**
   * Shopify "Buy shipping label" step 1 — real carrier rates for THIS order
   * (destination + real item weight + chosen/default package). Raw carrier
   * prices: the buyer-facing handling fee is not added to a label the seller buys.
   */
  async listShippingLabelRates(sellerId: string, orderId: string, storeId: string, packageId?: string, items?: { itemId: string; quantity: number }[]) {
    const ctx = await this.prepareLabelContext(sellerId, orderId, storeId, items);
    const originOverride = await this.labelOriginOverride(storeId, ctx.sellerOrder);
    const rates = await this.shippingRatesService.getLiveRates(storeId, ctx.destination, ctx.totalWeightKg, {
      packageId: packageId || undefined,
      forLabel: true,
      originOverride,
      customsDeclarationId: await this.customsDeclarationForLabel(storeId, ctx, originOverride),
    });
    const sorted = [...(rates ?? [])].sort((a, b) => a.amount - b.amount);
    return { success: true, data: { rates: sorted } };
  }

  /**
   * Shopify "Buy shipping label" step 2 — buys the label for the chosen
   * `rateId` (from listShippingLabelRates) — or, with no rateId, the CHEAPEST
   * live option — and marks the sellerOrder shipped with the real carrier /
   * tracking number Shippo issued. The label PDF URL, rate id, cost and time
   * are saved on `sellerOrder.tracking` (merchant-only; stripped for buyers).
   * Falls back with a clear error (not a silent no-op) whenever a live label
   * genuinely can't be purchased: store hasn't connected Shippo, this order
   * predates the `country` field on its address snapshot, or Shippo itself is
   * unreachable — the seller still has the manual
   * `updateSellerOrderStatus({status:'shipped', tracking})` path.
   */
  async purchaseShippingLabel(
    sellerId: string,
    orderId: string,
    storeId: string,
    ip?: string,
    userAgent?: string,
    opts: { rateId?: string; packageId?: string; items?: { itemId: string; quantity: number }[]; notifyCustomer?: boolean } = {},
  ) {
    const ctx = await this.prepareLabelContext(sellerId, orderId, storeId, opts.items);

    // Refuse BEFORE spending money on a label for an order that can't be shipped.
    if (!ctx.partial && !isAllowedSellerOrderTransition(ctx.sellerOrder.status, 'shipped')) {
      throw new BadRequestException(`Cannot buy a label for an order that is "${ctx.sellerOrder.status}".`);
    }

    let chosen: { rateId: string; carrier: string; amount: number; currency: string };
    if (opts.rateId) {
      const verified = await this.shippingRatesService.verifyRate(storeId, opts.rateId, { forLabel: true });
      if (!verified) {
        throw new BadRequestException('That shipping rate is no longer available — reload the rates and pick again.');
      }
      chosen = verified;
    } else {
      const originOverride = await this.labelOriginOverride(storeId, ctx.sellerOrder);
      const rates = await this.shippingRatesService.getLiveRates(storeId, ctx.destination, ctx.totalWeightKg, {
        packageId: opts.packageId || undefined,
        forLabel: true,
        originOverride,
        customsDeclarationId: await this.customsDeclarationForLabel(storeId, ctx, originOverride),
      });
      if (!rates || rates.length === 0) {
        throw new BadRequestException('No live carrier rate is available for this order — connect Shippo in Integrations, or use the manual tracking-number entry instead.');
      }
      chosen = rates.reduce((best, r) => (r.amount < best.amount ? r : best), rates[0]);
    }

    const label = await this.shippingRatesService.purchaseLabel(storeId, chosen.rateId);
    if (!label) {
      throw new BadRequestException('The label purchase failed — try again, or use the manual tracking-number entry instead.');
    }

    const tracking = {
      carrier: chosen.carrier,
      trackingNumber: label.trackingNumber,
      trackingUrl: label.trackingUrlProvider,
      labelUrl: label.labelUrl ?? null,
      labelRateId: chosen.rateId,
      labelCost: chosen.amount,
      labelCurrency: chosen.currency,
      labelPurchasedAt: new Date(),
    };

    // Partial shipment: the label becomes ONE shipment through the normal fulfil path (stock, status, buyer email, timeline);
    // the label fields live on that shipment's tracking (seller-only — buyer views only get carrier/number/url).
    if (ctx.partial) {
      try {
        return await this.fulfilItems(
          sellerId, storeId, orderId,
          { items: opts.items!, notifyCustomer: opts.notifyCustomer } as FulfilOrderDto,
          ip, userAgent, tracking,
        );
      } catch (err) {
        // The label is already paid for — keep its link on the merchant timeline so it is never lost.
        await this.pushTimeline(
          orderId, 'status',
          `Shipping label bought (${chosen.carrier} ${label.trackingNumber}) but the shipment could not be created: ${label.labelUrl ?? 'no label url'}`,
          sellerId, 'seller',
        );
        throw err;
      }
    }

    try {
      return await this.updateSellerOrderStatus(
        sellerId,
        { orderId, storeId, status: 'shipped' },
        ip,
        userAgent,
        tracking,
      );
    } catch (err) {
      // The label is already paid for — never lose it because the status
      // change lost a race / failed. Keep it on the order so the seller can print it.
      await this.databaseService.repositories.orderModel.updateOne(
        { _id: orderId, [`sellerOrders.${ctx.sellerOrderIndex}.storeId`]: storeId },
        { $set: { [`sellerOrders.${ctx.sellerOrderIndex}.tracking`]: tracking } },
      );
      throw err;
    }
  }

  /** Real FIFO/FEFO consumption for a lot-tracked variant (see StockLot
   *  schema) — drains the OLDEST active lot(s) first (earliest
   *  `expiryDate` when any active lot has one set, i.e. FEFO; otherwise
   *  plain FIFO by `receivedAt`), decrementing each lot's
   *  `quantityRemaining` and flipping it to `status:'depleted'` once it
   *  hits 0. Returns the real summed cost of the consumed units (rounded to
   *  2dp) — the actual `costOfGoodsSold` for this sale — or `null` if this
   *  variant has no lots at all yet (e.g. `trackLots` was just turned on
   *  and nothing has been received into a lot since; falls back to no COGS
   *  stamped for that line rather than guessing).
   *
   *  Deliberately scoped to this ONE real stock-leaving path (the
   *  fulfillment-time decrement above) and `InventoryService.
   *  applyStockAdjustment`'s manual stock-reducing reasons — not every
   *  conceivable stock-leaving code path in the app (POS sale, draft-order
   *  completion, refund/return-to-damaged) — a disclosed, deliberate scope
   *  boundary for this pass rather than a full retrofit of every
   *  historical stock-mutation call site. */
  private async consumeLotsFifo(variantId: string, quantity: number): Promise<number | null> {
    const { stockLotModel } = this.databaseService.repositories;
    let remainingToConsume = quantity;
    let totalCost = 0;
    let anyLotFound = false;

    const activeLots = await stockLotModel
      .find({ variantId, status: 'active', quantityRemaining: { $gt: 0 } })
      .sort({ expiryDate: 1, receivedAt: 1 })
      .lean();

    for (const lot of activeLots as any[]) {
      if (remainingToConsume <= 0) break;
      anyLotFound = true;
      const takeFromThisLot = Math.min(lot.quantityRemaining, remainingToConsume);
      totalCost += takeFromThisLot * lot.costPrice;
      remainingToConsume -= takeFromThisLot;

      const newRemaining = lot.quantityRemaining - takeFromThisLot;
      await stockLotModel.updateOne(
        { _id: lot._id },
        { $set: { quantityRemaining: newRemaining, status: newRemaining <= 0 ? 'depleted' : 'active' } },
      );
    }

    if (!anyLotFound) return null;
    return Math.round(totalCost * 100) / 100;
  }

  async updateSellerOrderStatus(
    sellerId: string,
    body: any,
    ip?: string,
    userAgent?: string,
    trustedTracking?: any,
  ) {
    const { orderId, storeId, status } = body;
    // Client-supplied tracking is limited to carrier/number/url — label fields are
    // only ever written by purchaseShippingLabel (trustedTracking).
    const rawTracking = body.tracking;
    const tracking =
      trustedTracking ??
      (rawTracking && typeof rawTracking === 'object'
        ? { carrier: rawTracking.carrier ?? null, trackingNumber: rawTracking.trackingNumber ?? null, trackingUrl: rawTracking.trackingUrl ?? null }
        : rawTracking);

    if (!orderId) throw new BadRequestException('orderId is required');
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!status) throw new BadRequestException('status is required');

    const validStatuses = ['processing', 'shipped', 'delivered', 'completed'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        `Invalid status. Allowed: ${validStatuses.join(', ')}`,
      );
    }

    const { orderModel, storeModel } = this.databaseService.repositories;

    // store ownership check
    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrderIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (sellerOrderIndex === -1) throw new ForbiddenException('Unauthorized');

    // Real safety net for Store.paymentCaptureMethod === 'manual' orders —
    // mirrors Shopify's own "Automatically when order is fulfilled" capture
    // option. `recordSale` below only ever fires once a sellerOrder reaches
    // 'completed', with no `isPaid` check of its own — for every OTHER
    // payment type that's fine (COD/manual-transfer orders are trusted to
    // have been paid by the time a seller ships them), but a manual-capture
    // Stripe authorization can genuinely expire with ZERO money ever having
    // moved. Auto-capturing it right here, the moment a seller first commits
    // to fulfilling the order, closes that gap — if the real Stripe capture
    // fails (authorization already expired/voided), this throws and blocks
    // the status change entirely, so an order can never be shipped AND
    // silently un-paid at the same time.
    if (order.paymentStatus === 'authorized' && ['shipped', 'delivered', 'completed'].includes(status)) {
      await this.paymentService.captureOrderPayment(sellerId, orderId);
    }

    // Guards against double-crediting the finance ledger if this sellerOrder was already
    // completed before this call (duplicate/retried request, double-click, etc.) — mirrors
    // the `order.isPaid` guard already used in `markPaid` below for the same reason.
    const wasAlreadyCompleted =
      order.sellerOrders[sellerOrderIndex].status === 'completed';

    // Forward-only state machine — a cancelled/refunded sub-order is final and
    // a fulfilled one never moves backwards (see isAllowedSellerOrderTransition).
    const currentSellerStatus: string = order.sellerOrders[sellerOrderIndex].status;
    if (!isAllowedSellerOrderTransition(currentSellerStatus, status)) {
      throw new BadRequestException(
        `Cannot change an order from "${currentSellerStatus}" to "${status}".`,
      );
    }

    // Local pickup: "shipped" means READY FOR PICKUP — no carrier, no tracking.
    const isPickup = order.fulfillmentMethod === 'pickup';
    if (status === 'shipped' && !tracking && !isPickup) {
      throw new BadRequestException(
        'tracking info required when status is shipped',
      );
    }

    const updateData: any = {};
    const soBase = `sellerOrders.${sellerOrderIndex}`;
    const priorShipments: any[] = order.sellerOrders[sellerOrderIndex].shipments ?? [];
    const statusNow = new Date();

    // sellerOrder status
    updateData[`${soBase}.status`] = status;

    // saare items same status — except cancelled/refunded lines, which are final
    const soItems = order.sellerOrders[sellerOrderIndex].items;
    soItems.forEach((item: any, itemIndex: number) => {
      if (item.status === 'cancelled' || item.status === 'refunded') return;
      updateData[`${soBase}.items.${itemIndex}.status`] = status;
    });

    // status-specific fields
    let shipmentToPush: any = null;
    if (status === 'shipped') {
      updateData[`${soBase}.shippedAt`] = statusNow;
      if (isPickup) {
        updateData[`${soBase}.pickupReadyAt`] = statusNow;
      } else {
        updateData[`${soBase}.tracking`] = tracking;
        // Whole-order "Mark shipped" = ONE shipment covering every still-unshipped unit, so the
        // shipments list stays consistent with the legacy single `tracking`.
        const remaining = unshippedLines(soItems, priorShipments);
        if (remaining.length > 0 && tracking && typeof tracking === 'object') {
          shipmentToPush = {
            _id: new Types.ObjectId(),
            items: remaining.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
            tracking,
            shippedAt: statusNow,
            deliveredAt: null,
            createdAt: statusNow,
          };
        }
      }
    }
    if (status === 'delivered' || status === 'completed') {
      if (status === 'delivered') updateData[`${soBase}.deliveredAt`] = statusNow;
      priorShipments.forEach((sh: any, shIdx: number) => {
        if (!sh.deliveredAt) updateData[`${soBase}.shipments.${shIdx}.deliveredAt`] = statusNow;
      });
    }

    // overall orderStatus derive — single source of truth, see
    // order-status.util.ts. Previously a hand-rolled if/else chain that fell
    // through silently (leaving `orderStatus` stale) for a status mix like
    // ['pending','processing'], which matched none of its three branches.
    const allStatuses = order.sellerOrders.map((so: any, idx: number) =>
      idx === sellerOrderIndex ? status : so.status,
    );
    updateData.orderStatus = deriveRollupStatus(allStatuses);

    // Real stock decrement happens HERE, not at order-creation — see
    // ProductVariant.committedStock's doc comment. Until now the item's
    // quantity only ever lived in `committedStock` (reserved at checkout);
    // reaching a fulfilled-or-beyond state is the actual physical-
    // fulfillment moment, so this is where genuine on-hand `stock` finally
    // drops and the reservation is released. Triggers on the FIRST
    // transition into shipped/delivered/completed — not just `status ===
    // 'shipped'` alone — since a seller can call this endpoint with
    // `status: 'delivered'` or `'completed'` directly without ever passing
    // through 'shipped' first (this method has no forced sequential state
    // machine); gating on shipped-only would silently leave that item's
    // reservation stuck in `committedStock` forever. Clamped at 0 rather
    // than a strict atomic guard — a seller manually adjusting stock down
    // (e.g. "damaged") between order-placement and shipment shouldn't
    // block a shipment that's already contractually committed to the buyer.
    // Atomic claim of this transition BEFORE any stock/ledger side effect:
    // the update only applies if the sub-order is STILL in the status we read.
    // Two concurrent requests (double-click, two tabs) can no longer both pass
    // the guards above and both decrement stock / credit the seller.
    // The shipments-count guard also loses the race against a concurrent partial "Fulfil items".
    const shipmentsPath = `${soBase}.shipments`;
    const shipmentsGuard =
      priorShipments.length === 0
        ? { $or: [{ [shipmentsPath]: { $exists: false } }, { [shipmentsPath]: { $size: 0 } }] }
        : { [shipmentsPath]: { $size: priorShipments.length } };
    const claimUpdate: any = { $set: updateData };
    if (shipmentToPush) claimUpdate.$push = { [shipmentsPath]: shipmentToPush };
    const claimed = await orderModel.findOneAndUpdate(
      { _id: orderId, isDelete: false, [`${soBase}.status`]: currentSellerStatus, ...shipmentsGuard },
      claimUpdate,
    );
    if (!claimed) {
      throw new ConflictException('This order was just updated by someone else — refresh and try again.');
    }
    let cogsUpdate: Record<string, any> = {};

    const FULFILLED_STATES = ['shipped', 'delivered', 'completed'];
    const wasAlreadyFulfilled = FULFILLED_STATES.includes(
      order.sellerOrders[sellerOrderIndex].status,
    );
    if (!wasAlreadyFulfilled && FULFILLED_STATES.includes(status) && !order.sellerOrders[sellerOrderIndex].stockAlreadyDeducted) {
      // Only the units NOT already shipped through a partial shipment (their stock moved at that time).
      cogsUpdate = await this.deductShippedStock(order.sellerOrders[sellerOrderIndex], sellerOrderIndex, unshippedLines(soItems, priorShipments));
    }

    if (Object.keys(cogsUpdate).length > 0) {
      await orderModel.updateOne({ _id: orderId }, { $set: cogsUpdate });
    }

    // Record sale in finance ledger when seller marks their order completed — only on the
    // transition into `completed`, never again if it was already completed (see guard above).
    if (status === 'completed' && !wasAlreadyCompleted) {
      const so = order.sellerOrders[sellerOrderIndex];
      // A Connect-settled sellerOrder's money already went straight to the
      // seller's own Stripe-connected account at payment time — crediting
      // the internal ledger here too would let them draw a second, duplicate
      // payout through the platform's own payout-request flow. See
      // PaymentService.initiatePayment/SellerOrder.settledViaConnect.
      if (!so.settledViaConnect) {
        const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
        const sponsoredCampaignId =
          so.items.find((i: any) => i.campaignSponsorType === 'platform')
            ?.campaignId ?? null;
        try {
          await this.financeService.recordSale(
            so.storeId,
            so.sellerId,
            orderId,
            sellerPayoutBasis(so),
            `Sale — Order #${orderId}`,
            platformSponsoredUSD,
            sponsoredCampaignId,
            sellerPayoutCurrency(so, order),
            order.paymentType,
          );
        } catch (e) {
          console.error('Finance recordSale failed:', e?.message);
        }
      }

      this.awardLoyaltyPoints(
        so.storeId,
        order.userId,
        orderId,
        so.subtotal,
      ).catch(() => {});
    }

    const so = order.sellerOrders[sellerOrderIndex];
    this.activityLogService.log({
      storeId: so.storeId,
      category: 'orders',
      action: status === 'shipped' ? 'order_fulfilled' : `order_${status}`,
      description: tracking && !isPickup
        ? `Order #${orderId} — shipped via ${tracking.carrier ?? tracking}`
        : `Order #${orderId} — status changed to ${status}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
      ip,
      userAgent,
    });

    if ((status === 'shipped' || status === 'delivered') && body.notifyCustomer !== false) {
      const orderNo = String(order.orderNumber ?? orderId);
      const storeName = (store as any).name ?? 'the store';
      const pickupInfo = order.pickupLocation ?? null;
      const pickupText = pickupInfo
        ? [pickupInfo.name, pickupInfo.address, pickupInfo.instructions].filter(Boolean).join(' — ')
        : '';
      let notifTitle: string;
      let notifBody: string;
      let notifEmail: { subject: string; html: string };
      if (status === 'shipped' && isPickup) {
        notifTitle = 'Your order is ready for pickup';
        notifBody = `Order #${orderNo} is ready for pickup${pickupText ? `: ${pickupText}` : ''}.`;
        notifEmail = buildReadyForPickupEmail({ storeName, orderNumber: orderNo, pickup: pickupInfo });
      } else if (status === 'shipped') {
        notifTitle = 'Your order has shipped';
        notifBody = `Order #${orderNo} is on its way${tracking?.carrier ? ` via ${tracking.carrier}` : ''}.`;
        notifEmail = buildShippedEmail({ storeName, orderNumber: orderNo, tracking });
      } else {
        notifTitle = isPickup ? 'Your order was picked up' : 'Your order was delivered';
        notifBody = isPickup ? `Order #${orderNo} has been picked up.` : `Order #${orderNo} has been delivered.`;
        notifEmail = buildDeliveredEmail({ storeName, orderNumber: orderNo, pickedUp: isPickup });
      }
      this.notificationsService
        .notify({
          recipientId: order.userId,
          recipientRole: 'user',
          storeId: so.storeId,
          type:
            status === 'shipped'
              ? NOTIFICATION_TYPES.ORDER_SHIPPED
              : NOTIFICATION_TYPES.ORDER_DELIVERED,
          title: notifTitle,
          body: notifBody,
          email: notifEmail,
          data: { orderId, status, fulfillmentMethod: isPickup ? 'pickup' : 'ship' },
          // Silently no-ops if `so.storeId` hasn't connected WhatsApp — see
          // NotifyParams.whatsapp. Template names below must already be
          // approved in that store's Meta Business Manager; if they aren't,
          // WhatsAppCloudProvider.sendTemplateMessage just logs and returns,
          // same as any other failed send.
          whatsapp: order.shippingAddress?.phoneNumber
            ? {
                storeId: so.storeId,
                to: order.shippingAddress.phoneNumber,
                templateName:
                  status === 'shipped' ? 'order_shipped' : 'order_delivered',
                languageCode: 'en_US',
                bodyParams:
                  status === 'shipped'
                    ? [orderId, tracking?.carrier ?? '']
                    : [orderId],
              }
            : undefined,
        })
        .catch(() => {});
    }

    const timelineMessage =
      isPickup && status === 'shipped' ? 'Ready for pickup'
      : isPickup && status === 'delivered' ? 'Marked as picked up'
      : `Order marked as ${status}${status === 'shipped' && tracking?.trackingNumber ? ` (tracking ${tracking.carrier ? tracking.carrier + ' ' : ''}${tracking.trackingNumber})` : ''}`;
    await this.pushTimeline(orderId, 'status', timelineMessage, sellerId, 'seller');
    return { success: true, message: `Order status updated to ${status}` };
  }

  /** Real stock hand-off for units that physically leave: drops on-hand `stock`, releases the checkout
   *  reservation (`committedStock`) and (lot-tracked variants) consumes lots FIFO/FEFO for real COGS.
   *  Shared by the whole-order status change and by each partial shipment. Returns the `$set` map of
   *  per-line cost-of-goods (accumulated onto any COGS a previous shipment already wrote). */
  private async deductShippedStock(so: any, soIndex: number, lines: FulfilLine[]): Promise<Record<string, any>> {
    const { productVariantModel } = this.databaseService.repositories;
    const cogsUpdate: Record<string, any> = {};
    for (const line of lines) {
      const item = so.items[line.itemIndex];
      if (!item || item.type !== 'physical' || !item.variantId) continue;
      const variant = await productVariantModel
        .findOne({ _id: item.variantId })
        .select('unlimitedStock stock committedStock trackLots')
        .lean();
      if (!variant || (variant as any).unlimitedStock) continue;
      const newStock = Math.max(0, (variant as any).stock - line.quantity);
      const newCommitted = Math.max(0, (variant as any).committedStock - line.quantity);
      await productVariantModel.updateOne(
        { _id: item.variantId },
        { $set: { stock: newStock, committedStock: newCommitted } },
      );

      // Real FIFO/FEFO cost-of-goods-sold — only for a lot-tracked variant (see StockLot schema /
      // consumeLotsFifo). This is the ACTUAL moment the unit leaves the building.
      if ((variant as any).trackLots) {
        const cogs = await this.consumeLotsFifo(item.variantId, line.quantity);
        if (cogs != null) {
          cogsUpdate[`sellerOrders.${soIndex}.items.${line.itemIndex}.costOfGoodsSold`] =
            Math.round(((Number(item.costOfGoodsSold) || 0) + cogs) * 100) / 100;
        }
      }
    }
    return cogsUpdate;
  }

  private static readonly FULFILLABLE_STATUSES = ['pending', 'processing', 'partially_shipped', 'partially_cancelled', 'partially_refunded'];

  /** Shopify "Fulfil items": creates ONE shipment for a subset/quantity of the still-unshipped lines.
   *  Every unit is validated against already-shipped quantities and the write is a conditional claim
   *  (status + shipments count), so concurrent fulfilments can never ship the same unit twice.
   *  When the last unit ships the sub-order moves to 'shipped' (same stock/COGS hand-off as the
   *  whole-order status change); until then it stays open and only the fully-shipped lines flip to 'shipped'. */
  async fulfilItems(sellerId: string, storeId: string, orderId: string, dto: FulfilOrderDto, ip?: string, userAgent?: string, trustedTracking?: any) {
    const { orderModel, storeModel } = this.databaseService.repositories;
    if (!isValidObjectId(orderId)) throw new BadRequestException('Invalid order id');
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = order.sellerOrders.findIndex((so: any) => so.storeId === storeId && so.sellerId === sellerId);
    if (soIndex === -1) throw new ForbiddenException('Unauthorized');
    if (order.fulfillmentMethod === 'pickup') {
      throw new BadRequestException('This is a pickup order — mark it ready for pickup instead of shipping it.');
    }

    const so = order.sellerOrders[soIndex];
    const current: string = so.status;
    if (!OrdersService.FULFILLABLE_STATUSES.includes(current)) {
      throw new BadRequestException(`Cannot fulfil an order that is "${current}".`);
    }
    const priorShipments: any[] = so.shipments ?? [];
    const check = validateFulfilRequest(so.items, priorShipments, dto.items);
    if (!check.ok) throw new BadRequestException(check.error);

    // Same safety net as the whole-order path: an authorized-only card payment is captured when the seller commits to ship.
    if (order.paymentStatus === 'authorized') {
      await this.paymentService.captureOrderPayment(sellerId, orderId);
    }

    // Label fields are only ever written by purchaseShippingLabel (trustedTracking), never from the request body.
    const tracking = trustedTracking ?? cleanTrackingInput({ carrier: dto.carrier, trackingNumber: dto.trackingNumber, trackingUrl: dto.trackingUrl });
    const now = new Date();
    const base = `sellerOrders.${soIndex}`;
    const shipment = {
      _id: new Types.ObjectId(),
      items: check.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
      tracking,
      shippedAt: now,
      deliveredAt: null,
      createdAt: now,
    };

    const after = shippedQtyByItem(priorShipments);
    for (const l of check.lines) after.set(l.itemId, (after.get(l.itemId) ?? 0) + l.quantity);
    const set: Record<string, any> = {};
    so.items.forEach((item: any, idx: number) => {
      if (item.status === 'cancelled' || item.status === 'refunded') return;
      if (check.allShipped) {
        set[`${base}.items.${idx}.status`] = 'shipped';
      } else if (isShippableItem(item)) {
        if ((after.get(String(item._id)) ?? 0) >= item.quantity) set[`${base}.items.${idx}.status`] = 'shipped';
        else if (item.status === 'pending') set[`${base}.items.${idx}.status`] = 'processing';
      }
    });

    let newStatus = current;
    if (check.allShipped) newStatus = 'shipped';
    else if (current === 'pending') newStatus = 'processing';
    if (newStatus !== current) set[`${base}.status`] = newStatus;
    if (!so.shippedAt) set[`${base}.shippedAt`] = now;
    if (tracking) set[`${base}.tracking`] = tracking; // legacy mirror = latest shipment
    set.orderStatus = deriveRollupStatus(order.sellerOrders.map((s: any, i: number) => (i === soIndex ? newStatus : s.status)));

    const shipmentsPath = `${base}.shipments`;
    const shipmentsGuard =
      priorShipments.length === 0
        ? { $or: [{ [shipmentsPath]: { $exists: false } }, { [shipmentsPath]: { $size: 0 } }] }
        : { [shipmentsPath]: { $size: priorShipments.length } };
    const claimed = await orderModel.findOneAndUpdate(
      { _id: orderId, isDelete: false, [`${base}.status`]: current, ...shipmentsGuard },
      { $set: set, $push: { [shipmentsPath]: shipment } },
    );
    if (!claimed) {
      throw new ConflictException('This order was just updated by someone else — refresh and try again.');
    }

    if (!so.stockAlreadyDeducted) {
      const cogsUpdate = await this.deductShippedStock(so, soIndex, check.lines);
      if (Object.keys(cogsUpdate).length > 0) await orderModel.updateOne({ _id: orderId }, { $set: cogsUpdate });
    }

    const lineSummary = check.lines.map((l) => `${l.quantity} × ${so.items[l.itemIndex]?.name ?? 'item'}`);
    this.activityLogService.log({
      storeId,
      category: 'orders',
      action: check.allShipped ? 'order_fulfilled' : 'order_partially_fulfilled',
      description: `Order #${orderId} — fulfilled ${lineSummary.join(', ')}${tracking?.carrier ? ` via ${tracking.carrier}` : ''}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
      ip,
      userAgent,
    });

    if (dto.notifyCustomer !== false) {
      const orderNo = String(order.orderNumber ?? orderId);
      const partial = !check.allShipped;
      this.notificationsService
        .notify({
          recipientId: order.userId,
          recipientRole: 'user',
          storeId,
          type: NOTIFICATION_TYPES.ORDER_SHIPPED,
          title: partial ? 'Part of your order has shipped' : 'Your order has shipped',
          body: `Order #${orderNo} is on its way${tracking?.carrier ? ` via ${tracking.carrier}` : ''}.`,
          data: { orderId, status: newStatus, shipmentId: String(shipment._id) },
          email: buildShippedEmail({ storeName: (store as any).name ?? 'the store', orderNumber: orderNo, tracking, partial, items: lineSummary }),
          whatsapp: order.shippingAddress?.phoneNumber
            ? {
                storeId,
                to: order.shippingAddress.phoneNumber,
                templateName: 'order_shipped',
                languageCode: 'en_US',
                bodyParams: [orderId, tracking?.carrier ?? ''],
              }
            : undefined,
        })
        .catch(() => {});
    }

    await this.pushTimeline(
      orderId,
      'status',
      `Fulfilled ${lineSummary.join(', ')}${tracking?.trackingNumber ? ` (tracking ${tracking.carrier ? tracking.carrier + ' ' : ''}${tracking.trackingNumber})` : ''}${check.allShipped ? ' — order fully shipped' : ''}`,
      sellerId,
      'seller',
    );
    return {
      success: true,
      message: check.allShipped ? 'Order fully fulfilled' : 'Items fulfilled',
      data: { shipmentId: String(shipment._id), status: newStatus, fullyShipped: check.allShipped },
    };
  }

  /** Edits the carrier / number / link of the LEGACY (pre-shipments) tracking of an already-shipped order.
   *  Orders that have shipments[] edit nothing here (their tracking belongs to each shipment). Label fields are never touched. */
  async updateLegacyTracking(
    sellerId: string, storeId: string, orderId: string,
    dto: { carrier?: string; trackingNumber?: string; trackingUrl?: string },
    actor: { actorId: string; actorRole: string },
  ) {
    const { orderModel, storeModel } = this.databaseService.repositories;
    if (!isValidObjectId(orderId)) throw new BadRequestException('Invalid order id');
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = order.sellerOrders.findIndex((so: any) => so.storeId === storeId && so.sellerId === sellerId);
    if (soIndex === -1) throw new ForbiddenException('Unauthorized');
    const so = order.sellerOrders[soIndex];
    if (Array.isArray(so.shipments) && so.shipments.length > 0) {
      throw new BadRequestException('This order was fulfilled with shipments — it has no single tracking to edit.');
    }
    if (!['shipped', 'delivered', 'completed'].includes(so.status)) {
      throw new BadRequestException('Tracking can only be edited on an order that has already shipped.');
    }
    const clean = cleanTrackingInput(dto as any);
    if (!clean) throw new BadRequestException('Enter a carrier, tracking number or tracking link.');

    const base = `sellerOrders.${soIndex}.tracking`;
    const set: Record<string, any> = so.tracking && typeof so.tracking === 'object'
      ? { [`${base}.carrier`]: clean.carrier, [`${base}.trackingNumber`]: clean.trackingNumber, [`${base}.trackingUrl`]: clean.trackingUrl }
      : { [base]: clean };
    await orderModel.updateOne({ _id: orderId, [`sellerOrders.${soIndex}.storeId`]: storeId }, { $set: set });

    this.activityLogService.log({
      storeId, category: 'orders', action: 'order_tracking_updated',
      description: `Order #${orderId} — tracking updated`,
      actorId: actor.actorId, actorRole: actor.actorRole as any, targetId: orderId, targetType: 'order',
    });
    await this.pushTimeline(
      orderId, 'status',
      `Tracking updated: ${[clean.carrier, clean.trackingNumber].filter(Boolean).join(' ') || 'link changed'}`,
      actor.actorId, actor.actorRole,
    );
    // Tell the buyer the tracking changed (never blocks the edit).
    this.notificationsService
      .notify({
        recipientId: order.userId,
        recipientRole: 'user',
        storeId,
        type: NOTIFICATION_TYPES.ORDER_SHIPPED,
        title: 'Tracking updated',
        body: `Order #${order.orderNumber ?? orderId} tracking: ${[clean.carrier, clean.trackingNumber].filter(Boolean).join(' ') || 'see link'}.`,
        data: { orderId },
        email: buildShippedEmail({ storeName: (store as any).name ?? 'the store', orderNumber: String(order.orderNumber ?? orderId), tracking: clean as any }),
      })
      .catch(() => {});
    return { success: true, message: 'Tracking updated', data: { tracking: clean } };
  }

  /** Shared by return-label rates + purchase: ownership, the BUYER's address as the ship-from, and the weight of the returned lines. */
  private async prepareReturnLabelContext(sellerId: string, orderId: string, storeId: string, itemIds: string[]) {
    const { orderModel, storeModel } = this.databaseService.repositories;
    if (!isValidObjectId(orderId)) throw new BadRequestException('Invalid order id');
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = order.sellerOrders.findIndex((so: any) => so.storeId === storeId && so.sellerId === sellerId);
    if (soIndex === -1) throw new ForbiddenException('Unauthorized');
    const so = order.sellerOrders[soIndex];

    const addr = order.shippingAddress as any;
    if (!addr || !addr.country) {
      throw new BadRequestException("This order's address has no country on file — arrange the return manually.");
    }
    const check = validateReturnLabelItems(so.items ?? [], itemIds);
    if (!check.ok) throw new BadRequestException(check.error);

    const totalWeightKg = await this.weightKgForLines(
      check.indexes.map((i) => ({ variantId: so.items[i]?.variantId, quantity: so.items[i]?.quantity ?? 1 })),
    );
    return {
      order, so, soIndex, store, indexes: check.indexes, totalWeightKg,
      buyerAddress: {
        name: addr.recipientName,
        street1: addr.addressLine1,
        street2: addr.addressLine2 ?? undefined,
        city: addr.city,
        state: addr.state,
        zip: addr.zipCode,
        country: addr.country,
        phone: addr.phoneNumber ?? undefined,
      },
    };
  }

  /** Real carrier rates for a RETURN label (buyer's address -> the store's ship-from address) for approved returned lines. */
  async listReturnLabelRates(sellerId: string, orderId: string, storeId: string, itemIds: string[], packageId?: string) {
    const ctx = await this.prepareReturnLabelContext(sellerId, orderId, storeId, itemIds);
    const rates = await this.shippingRatesService.getReturnLabelRates(storeId, ctx.buyerAddress, ctx.totalWeightKg, { packageId: packageId || undefined, originOverride: await this.labelOriginOverride(storeId, ctx.so) });
    return { success: true, data: { rates: [...(rates ?? [])].sort((a, b) => a.amount - b.amount) } };
  }

  /** Buys the Shippo return label for approved returned lines (chosen rate, else cheapest), stores it on each of those lines
   *  (seller-only cost; the buyer sees only the label link + tracking) and notifies the buyer. One label per line. */
  async purchaseReturnLabel(
    sellerId: string, storeId: string, orderId: string, itemIds: string[],
    opts: { rateId?: string; packageId?: string; notifyCustomer?: boolean } = {},
    actor: { actorId: string; actorRole: string },
  ) {
    const { orderModel } = this.databaseService.repositories;
    const ctx = await this.prepareReturnLabelContext(sellerId, orderId, storeId, itemIds);

    let chosen: { rateId: string; carrier: string; amount: number; currency: string };
    if (opts.rateId) {
      const verified = await this.shippingRatesService.verifyRate(storeId, opts.rateId, { forLabel: true });
      if (!verified) throw new BadRequestException('That shipping rate is no longer available — reload the rates and pick again.');
      chosen = verified;
    } else {
      const rates = await this.shippingRatesService.getReturnLabelRates(storeId, ctx.buyerAddress, ctx.totalWeightKg, { packageId: opts.packageId || undefined, originOverride: await this.labelOriginOverride(storeId, ctx.so) });
      if (!rates || rates.length === 0) {
        throw new BadRequestException('No live carrier rate is available for this return — connect Shippo in Integrations.');
      }
      chosen = rates.reduce((best, x) => (x.amount < best.amount ? x : best), rates[0]);
    }

    const bought = await this.shippingRatesService.purchaseLabel(storeId, chosen.rateId);
    if (!bought) throw new BadRequestException('The return label purchase failed — try again.');

    const returnLabel = {
      labelUrl: bought.labelUrl ?? null,
      trackingNumber: bought.trackingNumber ?? null,
      trackingUrl: bought.trackingUrlProvider ?? null,
      carrier: chosen.carrier,
      cost: chosen.amount,
      currency: chosen.currency,
      rateId: chosen.rateId,
      purchasedAt: new Date(),
    };

    const guard: Record<string, any> = { _id: orderId, isDelete: false };
    const set: Record<string, any> = {};
    for (const idx of ctx.indexes) {
      const p = `sellerOrders.${ctx.soIndex}.items.${idx}.returnLabel`;
      guard[p] = null; // matches "never issued" (absent or null) — a second click cannot overwrite the first label
      set[p] = returnLabel;
    }
    const names = ctx.indexes.map((i) => ctx.so.items[i]?.name ?? 'item');
    const claimed = await orderModel.findOneAndUpdate(guard, { $set: set });
    if (!claimed) {
      await this.pushTimeline(
        orderId, 'status',
        `Return label bought (${chosen.carrier} ${bought.trackingNumber}) but could not be saved: ${bought.labelUrl ?? 'no label url'}`,
        actor.actorId, actor.actorRole,
      );
      throw new ConflictException('A return label was just issued for these items by someone else — refresh.');
    }

    this.activityLogService.log({
      storeId, category: 'orders', action: 'return_label_purchased',
      description: `Order #${orderId} — return label (${chosen.carrier}) for ${names.join(', ')}`,
      actorId: actor.actorId, actorRole: actor.actorRole as any, targetId: orderId, targetType: 'order',
    });
    await this.pushTimeline(
      orderId, 'status',
      `Return label issued for ${names.join(', ')} (${chosen.carrier} ${bought.trackingNumber ?? ''})`.trim(),
      actor.actorId, actor.actorRole,
    );

    if (opts.notifyCustomer !== false) {
      const orderNo = String(ctx.order.orderNumber ?? orderId);
      this.notificationsService
        .notify({
          recipientId: ctx.order.userId,
          recipientRole: 'user',
          storeId,
          type: NOTIFICATION_TYPES.ORDER_UPDATED,
          title: 'Your return label is ready',
          body: `Download the prepaid return label for order #${orderNo}.`,
          data: { orderId, returnLabel: true },
          email: buildReturnLabelEmail({
            storeName: (ctx.store as any).name ?? 'the store', orderNumber: orderNo,
            labelUrl: returnLabel.labelUrl, carrier: returnLabel.carrier, trackingNumber: returnLabel.trackingNumber, items: names,
          }),
        })
        .catch(() => {});
    }

    return { success: true, message: 'Return label purchased', data: { returnLabel } };
  }

  /** Marks ONE shipment delivered. When every shipment of a fully-shipped sub-order is delivered, the
   *  sub-order itself becomes 'delivered' through the normal status path (buyer notification, forward-only rules). */
  async markShipmentDelivered(sellerId: string, storeId: string, orderId: string, shipmentId: string, ip?: string, userAgent?: string) {
    const { orderModel, storeModel } = this.databaseService.repositories;
    if (!isValidObjectId(orderId) || !isValidObjectId(shipmentId)) throw new BadRequestException('Invalid id');
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const order: any = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    const soIndex = order.sellerOrders.findIndex((so: any) => so.storeId === storeId && so.sellerId === sellerId);
    if (soIndex === -1) throw new ForbiddenException('Unauthorized');
    const so = order.sellerOrders[soIndex];
    if (so.status === 'cancelled' || so.status === 'refunded') throw new BadRequestException(`This order is ${so.status}.`);
    const shipments: any[] = so.shipments ?? [];
    const shIdx = shipments.findIndex((sh: any) => String(sh._id) === shipmentId);
    if (shIdx === -1) throw new NotFoundException('Shipment not found');

    if (!shipments[shIdx].deliveredAt) {
      const path = `sellerOrders.${soIndex}.shipments.${shIdx}`;
      const claimed = await orderModel.findOneAndUpdate(
        { _id: orderId, isDelete: false, [`${path}._id`]: shipments[shIdx]._id, [`${path}.deliveredAt`]: null },
        { $set: { [`${path}.deliveredAt`]: new Date() } },
      );
      if (claimed) await this.pushTimeline(orderId, 'status', 'Shipment marked as delivered', sellerId, 'seller');
    }

    const allDelivered = shipments.every((sh: any, i: number) => i === shIdx || !!sh.deliveredAt);
    if (allDelivered && so.status === 'shipped' && isFullyShipped(so.items, shipments)) {
      return this.updateSellerOrderStatus(sellerId, { orderId, storeId, status: 'delivered' }, ip, userAgent);
    }
    return { success: true, message: 'Shipment marked as delivered' };
  }

  /** Shared "this order is now fully paid" completion — sets isPaid/paidAt/
   *  orderStatus, completes every sellerOrder+item, credits the finance
   *  ledger (skipping Connect-settled sellerOrders, same guard as the
   *  status-transition branch elsewhere), awards loyalty points, notifies
   *  the buyer. Used by both the legacy one-click `markPaid()` and
   *  `recordOrderPayment()` once its cumulative recorded total reaches the
   *  order's full amount. */
  private async finalizeOrderPayment(order: any, orderId: string) {
    const { orderModel, productVariantModel } = this.databaseService.repositories;
    await this.pushTimeline(orderId, 'payment', 'Payment received — order completed', null, 'system');
    // Jumping straight to completed: release the reservation + drop real stock for not-yet-fulfilled sub-orders.
    await fulfilStockForSellerOrders(productVariantModel, order.sellerOrders);
    const now = new Date();
    const updateData: any = {
      isPaid: true,
      paymentStatus: 'paid',
      paidAt: now,
      orderStatus: 'completed',
    };

    order.sellerOrders.forEach((so: any, soIndex: number) => {
      updateData[`sellerOrders.${soIndex}.status`] = 'completed';
      updateData[`sellerOrders.${soIndex}.deliveredAt`] = now;
      so.items.forEach((_: any, itemIndex: number) => {
        updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] =
          'completed';
      });
    });

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    // Record sale in finance ledger for each store's sub-order — skipping
    // any that settled directly via Stripe Connect (see the same guard/
    // comment in the status-transition branch above).
    for (const so of order.sellerOrders) {
      if (so.settledViaConnect) continue;
      const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
      const sponsoredCampaignId =
        so.items.find((i: any) => i.campaignSponsorType === 'platform')
          ?.campaignId ?? null;
      try {
        await this.financeService.recordSale(
          so.storeId,
          so.sellerId,
          orderId,
          sellerPayoutBasis(so),
          `Sale — Order #${orderId}`,
          platformSponsoredUSD,
          sponsoredCampaignId,
          sellerPayoutCurrency(so, order),
          order.paymentType,
        );
      } catch (e) {
        console.error('Finance recordSale failed:', e?.message);
      }

      this.awardLoyaltyPoints(
        so.storeId,
        order.userId,
        orderId,
        so.subtotal,
      ).catch(() => {});
    }

    this.notificationsService
      .notify({
        recipientId: order.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.PAYMENT_SUCCESS,
        title: 'Payment received',
        body: `We've received your payment for order #${orderId}.`,
        data: { orderId },
      })
      .catch(() => {});
  }

  /** Legacy one-click "Mark as Paid" — kept byte-for-byte behaviorally
   *  unchanged (same signature, same lack of storeId scoping) so neither
   *  existing frontend caller (OrderList.tsx's quick action, OrderDetail's
   *  original button) needs to change. Now ALSO writes a real
   *  `OrderPaymentRecord` row for the full amount, so the payment ledger
   *  `recordOrderPayment`/the frontend payment-history list reads from
   *  stays complete regardless of which action a seller used. */
  async markPaid(
    sellerId: string,
    storeId: string,
    orderId: string,
    actor: { actorId: string; actorRole: 'seller' | 'staff' | 'admin' },
  ) {
    const { orderModel, storeModel, orderPaymentRecordModel } = this.databaseService.repositories;

    // Ownership: the caller's seller must own this store, and the order must
    // actually contain a sub-order for it.
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).select('_id').lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const mySo = (order.sellerOrders as any[]).find((so: any) => so.storeId === storeId);
    if (!mySo) throw new ForbiddenException('This order does not belong to your store');

    if (order.isPaid) throw new BadRequestException('Order is already paid');

    // A cancelled/refunded order must never be revived into a paid+completed
    // one (finalizeOrderPayment completes every sub-order and credits the ledger).
    const deadStatuses = ['cancelled', 'refunded'];
    if (
      deadStatuses.includes(order.orderStatus) ||
      (order.sellerOrders as any[]).some((so: any) => deadStatuses.includes(so.status))
    ) {
      throw new BadRequestException('A cancelled or refunded order cannot be marked as paid');
    }

    await this.finalizeOrderPayment(order, orderId);

    await orderPaymentRecordModel.create({
      orderId, storeId, sellerId,
      amount: order.totalAmount, currency: order.currency || 'USD',
      method: 'other', reference: null, note: 'Marked as paid (quick action)',
      recordedBy: actor.actorId, recordedByRole: actor.actorRole,
    });

    return { success: true, message: 'Order marked as paid' };
  }

  /**
   * Real "Record payments" — Shopify's actual permission: capture a
   * specific manually-collected payment (amount/method/reference/note)
   * against an order, supporting multiple partial entries (deposits/
   * installments) rather than one blind boolean flip. Automatically
   * finalizes the order (same completion path as `markPaid`) once the
   * cumulative recorded total reaches the order's full amount.
   */
  async recordOrderPayment(
    sellerId: string,
    storeId: string,
    orderId: string,
    body: { amount: number; method: 'cash' | 'bank_transfer' | 'other'; reference?: string; note?: string },
    actor: { actorId: string; actorRole: 'seller' | 'staff' | 'admin' },
  ) {
    const amount = Number(body?.amount);
    if (!amount || amount <= 0) throw new BadRequestException('A positive amount is required');
    if (!['cash', 'bank_transfer', 'other'].includes(body?.method)) {
      throw new BadRequestException('A valid payment method is required');
    }

    const { orderModel, storeModel, orderPaymentRecordModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.isPaid) throw new BadRequestException('This order is already fully paid');

    const belongsToStore = (order.sellerOrders as any[]).some((so: any) => so.storeId === storeId);
    if (!belongsToStore) throw new ForbiddenException('This order does not belong to your store');
    if (['cancelled', 'refunded'].includes(order.orderStatus) || (order.sellerOrders as any[]).some((so: any) => ['cancelled', 'refunded'].includes(so.status))) {
      throw new BadRequestException('A cancelled or refunded order cannot receive payments');
    }

    const existingTotal = await orderPaymentRecordModel.aggregate([
      { $match: { orderId } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const alreadyRecorded = existingTotal[0]?.total ?? 0;
    const remaining = round(order.totalAmount - alreadyRecorded);
    if (amount > remaining) {
      throw new BadRequestException(`Amount exceeds what's left to record on this order (max ${remaining}).`);
    }

    await orderPaymentRecordModel.create({
      orderId, storeId, sellerId,
      amount, currency: order.currency || 'USD',
      method: body.method, reference: (body.reference ?? '').trim() || null, note: (body.note ?? '').trim(),
      recordedBy: actor.actorId, recordedByRole: actor.actorRole,
    });

    const newTotal = round(alreadyRecorded + amount);
    const fullyPaid = newTotal >= round(order.totalAmount);
    if (fullyPaid) {
      await this.finalizeOrderPayment(order, orderId);
    } else {
      await orderModel.updateOne({ _id: orderId }, { $set: { paymentStatus: 'partially_paid' } });
    }

    return {
      success: true,
      message: fullyPaid ? 'Payment recorded — order is now fully paid' : 'Payment recorded',
      data: { orderId, amount, totalRecorded: newTotal, remaining: round(order.totalAmount - newTotal), fullyPaid },
    };
  }

  /** Real payment-ledger list for an order — every manually-recorded entry
   *  (OrdersService.recordOrderPayment), newest first. */
  async listOrderPayments(sellerId: string, storeId: string, orderId: string) {
    const { storeModel, orderPaymentRecordModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false }).lean();
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return orderPaymentRecordModel
      .find({ orderId, storeId })
      .sort({ createdAt: -1 })
      .lean();
  }

  async downloadFile(
    userId: string,
    orderId: string,
    productId: string,
    fileIndex: number,
  ) {
    const { orderModel, productModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid');

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product?.digital?.files?.length)
      throw new NotFoundException('Product files not found');

    const file = product.digital.files[fileIndex];
    if (!file) throw new NotFoundException('File not found');

    const mimeType = this.uploadService.resolveMimeType(
      file.name,
      file.mimeType ?? 'application/octet-stream',
    );
    const resourceType = mimeType.startsWith('video/')
      ? 'video'
      : mimeType.startsWith('image/')
        ? 'image'
        : 'raw';
    const signedUrl = this.uploadService.generateSignedUrl(
      file.url,
      resourceType,
      300,
    );

    const response = await fetch(signedUrl);
    if (!response.ok)
      throw new BadRequestException('Failed to fetch file from storage');

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return { buffer, fileName: file.name, mimeType };
  }

  async streamStampedPdfByToken(token: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new BadRequestException('Download link expired or invalid');
    }
    return this.streamStampedPdf(
      payload.userId,
      payload.orderId,
      payload.productId,
      payload.fileIndex,
      payload.storeId,
    );
  }

  /** Confirms `productId` is one of the items in one of THIS store's
   *  sellerOrder(s) on this order — closes both the cross-store leak and an
   *  otherwise-unchecked path where any paid order + any digital productId
   *  would resolve a download, whether or not that product was actually
   *  purchased. */
  private assertDigitalItemInStoreOrder(order: any, productId: string, storeId: string) {
    const inThisStore = (order.sellerOrders as any[]).some(
      (so: any) =>
        so.storeId === storeId &&
        (so.items as any[]).some((item: any) => item.productId === productId),
    );
    if (!inThisStore) throw new BadRequestException('Product not found in this order');
  }

  async streamStampedPdf(
    userId: string,
    orderId: string,
    productId: string,
    fileIndex: number,
    storeId: string,
  ) {
    const { orderModel, productModel, userModel } =
      this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid');
    this.assertDigitalItemInStoreOrder(order, productId, storeId);

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product?.digital?.files?.length)
      throw new NotFoundException('Product files not found');

    const file = product.digital.files[fileIndex];
    if (!file) throw new NotFoundException('File not found');

    const user = await userModel
      .findOne({ _id: userId })
      .select('email')
      .lean();
    const userEmail = (user as any)?.email || userId;

    const stampedBuffer = await this.uploadService.stampPdf(
      file.url,
      userEmail,
      order.orderNumber,
    );

    return {
      buffer: stampedBuffer,
      fileName: file.name,
      mimeType: 'application/pdf',
    };
  }

  async getDownloadLink(
    userId: string,
    orderId: string,
    productId: string,
    fileIndex: number,
    storeId: string,
  ) {
    const { orderModel, productModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid yet');
    this.assertDigitalItemInStoreOrder(order, productId, storeId);

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product?.digital?.files?.length)
      throw new NotFoundException('Product files not found');

    const file = product.digital.files[fileIndex];
    if (!file) throw new NotFoundException('File not found at this index');

    const token = this.jwtService.sign(
      { userId, orderId, productId, fileIndex, storeId },
      {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: '10m',
      },
    );

    const resolvedMimeType = this.uploadService.resolveMimeType(
      file.name,
      file.mimeType ?? 'application/octet-stream',
    );
    const isPdfStamped =
      resolvedMimeType === 'application/pdf' &&
      product.digital?.pdfStampingEnabled;

    return {
      success: true,
      data: {
        token,
        endpoint: isPdfStamped
          ? '/api/orders/stream-pdf-token'
          : '/api/orders/download-file',
        fileName: file.name,
        expiresIn: '10 minutes',
      },
    };
  }

  async cancelOrder(userId: string, orderId: string, body: any, storeId: string) {
    const { reason, itemIds } = body;
    if (!reason) throw new BadRequestException('reason is required');

    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({
      _id: orderId,
      userId,
      isDelete: false,
    });
    if (!order) throw new NotFoundException('Order not found');

    // A buyer's cancel must never touch another store's items within the
    // same (possibly multi-store legacy) order. Default to every item on
    // THIS store's sellerOrder(s) when no explicit itemIds were given
    // (matches the old "cancel everything" behavior for the common
    // single-store-order case), and reject any explicitly-given id that
    // doesn't belong to this store.
    const storeItemIds: string[] = (order.sellerOrders as any[])
      .filter((so: any) => so.storeId === storeId)
      .flatMap((so: any) => (so.items as any[]).map((item: any) => item._id.toString()));
    if (storeItemIds.length === 0) throw new NotFoundException('Order not found');

    const scopedItemIds =
      itemIds && Array.isArray(itemIds) && itemIds.length > 0 ? itemIds : storeItemIds;
    const foreignItemId = scopedItemIds.find((id: string) => !storeItemIds.includes(id));
    if (foreignItemId) {
      throw new ForbiddenException('One or more items do not belong to this store');
    }

    return this.executeCancellation(order, scopedItemIds, reason, {
      actorId: userId,
      actorRole: 'user',
      notifyRecipientRole: 'seller',
      notifyTitle: 'Order cancelled by buyer',
      notifyBody: (id: string) =>
        `Order #${id} was cancelled by the buyer — ${reason}`,
    });
  }

  /**
   * Seller-initiated cancellation (e.g. out-of-stock) — previously did not
   * exist at all; a seller had no way to cancel an order except asking the
   * buyer to do it themselves. Scoped to ONLY this seller's own sellerOrder
   * within the (possibly multi-seller) order — never another seller's items
   * on the same order, and `itemIds` (if given) must all belong to it.
   */
  async cancelOrderAsSeller(
    sellerId: string,
    storeId: string,
    orderId: string,
    body: any,
  ) {
    const { reason, itemIds } = body;
    if (!reason) throw new BadRequestException('reason is required');

    const { orderModel, storeModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const sellerOrder = (order.sellerOrders as any[]).find(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (!sellerOrder) throw new ForbiddenException('Unauthorized');

    // A seller may only target their own sellerOrder's items — if no
    // itemIds given, default to every item on THIS sellerOrder only (never
    // "the whole order" the way a buyer's full cancel does, since a
    // multi-seller order's other stores must never be touched by this call).
    const ownItemIds =
      itemIds && Array.isArray(itemIds) && itemIds.length > 0
        ? itemIds
        : sellerOrder.items.map((i: any) => i._id.toString());
    const foreignItemId = ownItemIds.find(
      (id: string) =>
        !sellerOrder.items.some((i: any) => i._id.toString() === id),
    );
    if (foreignItemId)
      throw new ForbiddenException(
        `Item not found on your store's order: ${foreignItemId}`,
      );

    return this.executeCancellation(order, ownItemIds, reason, {
      actorId: sellerId,
      actorRole: 'seller',
      notifyRecipientRole: 'user',
      notifyTitle: 'Order cancelled by seller',
      notifyBody: (id: string) =>
        `Order #${id} was cancelled by the seller — ${reason}`,
    });
  }

  /**
   * Shared cancellation core — builds the item/sellerOrder/order status
   * updates (via `deriveRollupStatus`, see order-status.util.ts), restores
   * physical stock, and — for a paid order — moves REAL money: debits each
   * affected seller's wallet via `FinanceService.recordRefund` and issues a
   * real targeted Stripe refund for the buyer-facing amount. Previously this
   * only ever flipped `paymentStatus` to 'refunded' in the DB with a comment
   * admitting "no real Stripe call" — cancelling a paid order moved zero
   * real money. Used by both the buyer (`cancelOrder`) and seller
   * (`cancelOrderAsSeller`) entry points, which differ only in ownership
   * checks and which items they're allowed to target.
   */
  private async executeCancellation(
    order: any,
    itemIds: string[] | undefined,
    reason: string,
    actor: {
      actorId: string;
      actorRole: 'user' | 'seller';
      notifyRecipientRole: 'user' | 'seller';
      notifyTitle: string;
      notifyBody: (orderId: string) => string;
    },
  ) {
    const orderId = order._id.toString();
    const { orderModel, productVariantModel } =
      this.databaseService.repositories;

    if (order.orderStatus === 'completed')
      throw new BadRequestException('Completed orders cannot be cancelled');
    if (order.orderStatus === 'cancelled')
      throw new BadRequestException('Order is already cancelled');

    const now = new Date();
    const BLOCKED = ['shipped', 'delivered', 'completed', 'cancelled'];

    // flatten all items with their indices
    const allItems: { soIndex: number; itemIndex: number; item: any }[] = [];
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      so.items.forEach((item: any, itemIndex: number) => {
        allItems.push({ soIndex, itemIndex, item });
      });
    });

    let targetItems: { soIndex: number; itemIndex: number; item: any }[];

    if (itemIds && Array.isArray(itemIds) && itemIds.length > 0) {
      // item-level cancel
      targetItems = [];
      for (const itemId of itemIds) {
        const found = allItems.find(
          ({ item }) => item._id.toString() === itemId,
        );
        if (!found) throw new BadRequestException(`Item not found: ${itemId}`);
        if (found.item.status === 'cancelled')
          throw new BadRequestException(
            `Item "${found.item.name}" is already cancelled`,
          );
        if (BLOCKED.includes(found.item.status))
          throw new BadRequestException(
            `Item "${found.item.name}" cannot be cancelled — status: ${found.item.status}`,
          );
        targetItems.push(found);
      }
    } else {
      // full order cancel — koi bhi item shipped nahi honi chahiye
      const blockedItem = allItems.find(({ item }) =>
        BLOCKED.slice(0, 3).includes(item.status),
      );
      if (blockedItem)
        throw new BadRequestException(
          `Cannot cancel order — "${blockedItem.item.name}" is already ${blockedItem.item.status}`,
        );
      targetItems = allItems.filter(({ item }) => item.status !== 'cancelled');
    }

    if (targetItems.length === 0)
      throw new BadRequestException('No items to cancel');

    const updateData: any = {};

    for (const { soIndex, itemIndex, item } of targetItems) {
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] =
        'cancelled';
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelledAt`] =
        now;
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.cancelReason`] =
        reason;
      if (order.isPaid) {
        updateData[
          `sellerOrders.${soIndex}.items.${itemIndex}.refundedAmount`
        ] = item.totalPrice;
      }
    }

    // sellerOrder status recalculate — unconditional now (see
    // order-status.util.ts): a PARTIAL cancellation must still update this
    // seller order's rollup status.
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      const updatedStatuses = so.items.map((item: any, itemIndex: number) => {
        const wasUpdated = targetItems.find(
          (t) => t.soIndex === soIndex && t.itemIndex === itemIndex,
        );
        return wasUpdated ? 'cancelled' : item.status;
      });
      updateData[`sellerOrders.${soIndex}.status`] =
        deriveRollupStatus(updatedStatuses);
      if (updatedStatuses.every((s: string) => s === 'cancelled')) {
        updateData[`sellerOrders.${soIndex}.cancelledAt`] = now;
        updateData[`sellerOrders.${soIndex}.cancelReason`] = reason;
      }
    });

    // overall orderStatus recalculate — also unconditional now, same reason.
    const updatedSOStatuses = order.sellerOrders.map(
      (so: any, soIndex: number) =>
        updateData[`sellerOrders.${soIndex}.status`] ?? so.status,
    );
    updateData.orderStatus = deriveRollupStatus(updatedSOStatuses);
    if (order.isPaid) updateData.paymentStatus = 'refunded';

    // What the buyer is owed back per sub-order: each cancelled item's price PLUS its own tax share (the buyer was charged
    // tax on it and the seller was credited it — see SellerOrder.taxAmount).
    const amountBySoIndex = new Map<number, number>();
    if (order.isPaid) {
      for (const { soIndex, item } of targetItems) {
        amountBySoIndex.set(soIndex, (amountBySoIndex.get(soIndex) ?? 0) + item.totalPrice + (item.taxUSD ?? 0));
      }
    }
    // Take the money out of the ONE shared refund budget (clamped to what is still left — e.g. part of it may already have
    // been refunded through a standalone refund / approved return) BEFORE claiming, so a lost race can give it back.
    const grantedBySoIndex = new Map<number, number>();
    for (const [soIndex, amount] of amountBySoIndex) {
      grantedBySoIndex.set(soIndex, await reserveRefundCapacity(orderModel, orderId, soIndex, amount, { clamp: true }));
    }
    const releaseGrants = async () => { for (const [i, g] of grantedBySoIndex) await releaseRefundCapacity(orderModel, orderId, i, g).catch(() => undefined); };

    // Optimistic lock FIRST — this method has TWO independent entry points (`cancelOrder` for the buyer,
    // `cancelOrderAsSeller` for the seller), both computing `updateData` from the SAME `order` snapshot. The
    // claim only applies if the order is still exactly as that snapshot (matching `updatedAt`), so a buyer and
    // a seller cancelling at nearly the same moment can no longer BOTH pass and BOTH release stock / refund the
    // card / reverse the ledger — the loser gets a clear, retryable error and nothing has been touched yet.
    // (Previously the stock/ledger/Stripe side effects ran before this check, so a lost race had already
    // double-refunded by the time it was detected.)
    const claimed = await orderModel.findOneAndUpdate(
      { _id: orderId, updatedAt: order.updatedAt },
      { $set: updateData },
    );
    if (!claimed) {
      await releaseGrants();
      throw new BadRequestException(
        'This order was just modified by someone else — please refresh and try again.',
      );
    }

    // physical items — release the reservation (never a real `stock` restore here): `BLOCKED` above already
    // guarantees these items were still 'pending'/'processing', i.e. only ever reserved via `committedStock`
    // at checkout, never shipped/decremented from real `stock` — see ProductVariant.committedStock's doc comment.
    for (const { item } of targetItems) {
      if (item.type === 'physical' && item.variantId) {
        await productVariantModel.updateOne(
          { _id: item.variantId, unlimitedStock: { $ne: true } },
          [{ $set: { committedStock: { $max: [0, { $subtract: ['$committedStock', item.quantity] }] } } }],
          { updatePipeline: true } as any,
        );
      }
    }

    // ── Real money movement (paid orders only) ──────────────────────────
    let totalBuyerRefund = 0;
    if (order.isPaid) {
      const buyerCurrency = order.currency || 'USD';

      for (const [soIndex] of amountBySoIndex) {
        const amount = grantedBySoIndex.get(soIndex) ?? 0; // never more than the shared budget still allowed
        if (!(amount > 0)) continue;
        const so = order.sellerOrders[soIndex];
        const settlementCurrency = so.settlementCurrency ?? buyerCurrency;
        const sellerDebitAmount = this.exchangeRateService.convertWithSnapshots(
          amount,
          buyerCurrency,
          settlementCurrency,
          order.fxSnapshots ?? [],
        );
        try {
          await this.financeService.recordRefund(
            so.storeId,
            so.sellerId,
            orderId,
            sellerDebitAmount,
            actor.actorId,
            actor.actorRole,
            {
              description: `Order cancelled — Order #${order.orderNumber}`,
              targetType: 'order',
              currency: settlementCurrency,
            },
          );
        } catch (e: any) {
          console.error(
            'Finance recordRefund failed (order cancellation):',
            e?.message,
          );
        }
        totalBuyerRefund += amount;
      }

      if (order.paymentType === 'stripe' && totalBuyerRefund > 0) {
        const transaction =
          await this.databaseService.repositories.paymentTransactionModel.findOne(
            {
              orderIds: orderId,
              status: 'completed',
              isDelete: false,
            },
          );
        if (transaction?.stripePaymentIntentId) {
          try {
            await this.paymentService.refundStripePaymentIntent(
              transaction.stripePaymentIntentId,
              totalBuyerRefund,
              `order_cancel_${orderId}_${targetItems.map((t) => t.item._id.toString()).sort().join(",")}`,
            );
          } catch (e: any) {
            // Ledger already reversed above — same disclosed failure mode as
            // refund-request.service.ts's approve(): a failed Stripe call
            // here means the seller's wallet was correctly debited but the
            // buyer's card hasn't been refunded yet, surfaced as a security
            // alert rather than silently swallowed.
            await this.activityLogService.log({
              storeId: 'platform',
              category: 'finance',
              action: 'stripe_refund_failed_after_cancellation',
              description: `Stripe refund failed for cancelled order #${order.orderNumber} after seller ledger(s) already reversed: ${e?.message}`,
              actorId: actor.actorId,
              actorRole: actor.actorRole,
              isSecurityAlert: true,
              targetId: orderId,
              targetType: 'order',
            });
          }
        }
      }
    }

    // ── Gift-card balance reversal (paid or not — a gift card is redeemed
    // at order-placement time regardless of payment method, see
    // PaymentService.createOrder, so it must be restored here regardless of
    // `order.isPaid` too) ────────────────────────────────────────────────
    if (order.giftCardCode) {
      const giftCardReverseAmount = targetItems.reduce(
        (sum, { item }) => sum + (item.giftCardDiscountUSD || 0),
        0,
      );
      if (giftCardReverseAmount > 0) {
        const giftCardSellerOrder = order.sellerOrders.find((so: any) =>
          so.items.some((i: any) => i.giftCardDiscountUSD > 0),
        );
        if (giftCardSellerOrder) {
          await this.giftCardsService.restoreOnRefund(
            giftCardSellerOrder.storeId,
            order.giftCardCode,
            giftCardReverseAmount,
            orderId,
            `cancel:${orderId}:${targetItems.map((t) => t.item._id.toString()).sort().join(',')}`,
            `Order #${order.orderNumber} cancelled`,
          ).catch((e: any) => console.error('Gift card reversal failed (order cancellation):', e?.message));
        }
      }
    }

    // ── Store-credit reversal — credit is spent at order placement (see PaymentService.createOrder),
    // so cancelled items give back exactly the credit they consumed (idempotent per cancellation).
    {
      const storeCreditReverseAmount = targetItems.reduce(
        (sum, { item }) => sum + (item.storeCreditDiscountUSD || 0),
        0,
      );
      if (storeCreditReverseAmount > 0) {
        const scSellerOrder = order.sellerOrders.find((so: any) =>
          so.items.some((i: any) => i.storeCreditDiscountUSD > 0),
        );
        if (scSellerOrder) {
          await this.storeCreditService.restoreOnRefund(
            scSellerOrder.storeId,
            order.userId,
            storeCreditReverseAmount,
            orderId,
            `cancel:${orderId}:${targetItems.map((t) => t.item._id.toString()).sort().join(',')}`,
            `Order #${order.orderNumber} cancelled`,
          ).catch((e: any) => console.error('Store credit reversal failed (order cancellation):', e?.message));
        }
      }
    }


    await this.pushTimeline(orderId, 'cancel', `${targetItems.length} item(s) cancelled — ${reason}`, actor.actorId, actor.actorRole);

    if (actor.notifyRecipientRole === 'seller') {
      const affectedSellerOrders = new Map<string, { sellerId: string; storeId: string }>();
      targetItems.forEach(({ soIndex }) => {
        const so = order.sellerOrders[soIndex];
        affectedSellerOrders.set(`${so.sellerId}:${so.storeId}`, { sellerId: so.sellerId, storeId: so.storeId });
      });
      affectedSellerOrders.forEach(({ sellerId, storeId }) => {
        this.notificationsService
          .notify({
            recipientId: sellerId,
            recipientRole: 'seller',
            storeId,
            type: NOTIFICATION_TYPES.ORDER_CANCELLED,
            title: actor.notifyTitle,
            body: actor.notifyBody(orderId),
            data: { orderId, storeId },
          })
          .catch(() => {});
      });
    } else {
      this.notificationsService
        .notify({
          recipientId: order.userId,
          recipientRole: 'user',
          type: NOTIFICATION_TYPES.ORDER_CANCELLED,
          title: actor.notifyTitle,
          body: actor.notifyBody(orderId),
          data: { orderId },
        })
        .catch(() => {});
    }

    return {
      success: true,
      message:
        targetItems.length === allItems.length
          ? 'Order cancelled successfully'
          : `${targetItems.length} item(s) cancelled successfully`,
      data: {
        orderId,
        cancelledItems: targetItems.length,
        refundProcessed: order.isPaid,
      },
    };
  }

  /**
   * Standalone "Refund $X" — Shopify's real "Refund to original payment
   * method" as its own action, independent of Cancel/Return: no item is
   * cancelled/returned, nothing about fulfillment status changes. Used for a
   * goodwill partial refund, a shipping-fee waiver after the fact, a
   * price-adjustment credit, etc. Real money movement, same primitives
   * `executeCancellation` already uses (FX-converted ledger debit + a real
   * targeted Stripe refund) — capped by `SellerOrder.manualRefundedAmount`
   * plus the sum of any item-level `refundedAmount` already issued via
   * cancellation/return, so the two mechanisms can never together refund
   * more than the sellerOrder's own subtotal.
   */
  async refundOrderAsSeller(
    sellerId: string,
    storeId: string,
    orderId: string,
    body: { amount: number; reason?: string; refundTo?: 'original' | 'store_credit' },
  ) {
    const amount = Number(body?.amount);
    if (!amount || amount <= 0) throw new BadRequestException('A positive refund amount is required');
    const toStoreCredit = body?.refundTo === 'store_credit';
    const reason = (body?.reason ?? '').trim() || 'Refund issued by seller';

    const { orderModel, storeModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.isPaid) throw new BadRequestException('This order has not been paid yet — nothing to refund');

    const soIndex = (order.sellerOrders as any[]).findIndex(
      (so: any) => so.storeId === storeId && so.sellerId === sellerId,
    );
    if (soIndex === -1) throw new ForbiddenException('Unauthorized');
    const so = (order.sellerOrders as any[])[soIndex];

    const alreadyRefunded =
      (so.items as any[]).reduce((sum, i: any) => sum + (i.refundedAmount || 0), 0) +
      (so.manualRefundedAmount || 0);
    // The ONE shared refund budget (cancel / return / refund request / edit all draw from it) — atomic.
    await reserveRefundCapacity(orderModel, orderId, soIndex, amount);
    const giveBack = () => releaseRefundCapacity(orderModel, orderId, soIndex, amount).catch(() => undefined);

    const buyerCurrency = order.currency || 'USD';

    // Shopify "Refund to store credit": the money stays with the merchant and comes back to the
    // buyer as spendable credit in THIS store — so there is no card refund and no ledger debit
    // (the sale proceeds are simply never paid out twice: the credit later reduces what the buyer
    // pays on a new order). Idempotency key carries the amount-so-far so two refunds are two lots.
    if (toStoreCredit) {
      const storeCurrency = (store as any).baseCurrency ?? buyerCurrency;
      const creditAmount = round(
        this.exchangeRateService.convertWithSnapshots(amount, buyerCurrency, storeCurrency, order.fxSnapshots ?? []),
      );
      try {
        await this.storeCreditService.creditFromRefund(
          storeId,
          order.userId,
          creditAmount,
          orderId,
          `refund:${orderId}:${round(alreadyRefunded)}`,
          `Order #${order.orderNumber} — ${reason}`,
          { actorId: sellerId, actorRole: 'seller' } as any,
        );
      } catch (err) {
        await giveBack();
        throw err;
      }
      await orderModel.updateOne(
        { _id: orderId },
        { $inc: { [`sellerOrders.${soIndex}.manualRefundedAmount`]: amount } },
      );
      await this.activityLogService.log({
        storeId, category: 'orders', action: 'order_refunded_to_store_credit',
        description: `Refunded ${amount} ${buyerCurrency} to store credit on order #${order.orderNumber} — ${reason}`,
        actorId: sellerId, actorRole: 'seller', targetId: orderId, targetType: 'order',
      });
      return {
        success: true,
        message: 'Refunded to store credit',
        data: { orderId, amount, refundedTo: 'store_credit', stripeRefundId: null },
      };
    }

    const settlementCurrency = so.settlementCurrency ?? buyerCurrency;
    const sellerDebitAmount = this.exchangeRateService.convertWithSnapshots(
      amount,
      buyerCurrency,
      settlementCurrency,
      order.fxSnapshots ?? [],
    );

    try {
      await this.financeService.recordRefund(
        storeId,
        sellerId,
        orderId,
        sellerDebitAmount,
        sellerId,
        'seller',
        {
          description: `Refund issued — Order #${order.orderNumber} — ${reason}`,
          targetType: 'order',
          currency: settlementCurrency,
        },
      );
    } catch (e: any) {
      console.error('Finance recordRefund failed (standalone seller refund):', e?.message);
      await giveBack();
      throw new BadRequestException('Failed to record the refund against your balance — please try again.');
    }

    let stripeRefundId: string | null = null;
    if (order.paymentType === 'stripe') {
      const transaction = await this.databaseService.repositories.paymentTransactionModel.findOne({
        orderIds: orderId, status: 'completed', isDelete: false,
      });
      if (transaction?.stripePaymentIntentId) {
        try {
          const refund = await this.paymentService.refundStripePaymentIntent(
            transaction.stripePaymentIntentId,
            amount,
            `order_manual_refund_${orderId}_${Date.now()}`,
          );
          stripeRefundId = refund?.id ?? null;
        } catch (e: any) {
          await this.activityLogService.log({
            storeId: 'platform', category: 'finance',
            action: 'stripe_refund_failed_after_manual_refund',
            description: `Stripe refund failed for order #${order.orderNumber} after the seller's ledger was already debited: ${e?.message}`,
            actorId: sellerId, actorRole: 'seller',
            isSecurityAlert: true, targetId: orderId, targetType: 'order',
          });
        }
      }
    }

    await orderModel.updateOne(
      { _id: orderId },
      { $inc: { [`sellerOrders.${soIndex}.manualRefundedAmount`]: amount } },
    );

    await this.pushTimeline(orderId, 'refund', `Refunded ${amount} ${buyerCurrency} to the original payment method — ${reason}`, sellerId, 'seller');
    await this.activityLogService.log({
      storeId, category: 'orders', action: 'order_manual_refund_issued',
      description: `Refunded ${amount} ${buyerCurrency} on order #${order.orderNumber} — ${reason}`,
      actorId: sellerId, actorRole: 'seller', targetId: orderId, targetType: 'order',
      metadata: buildDiffMetadata(
        { refundedAmount: round(alreadyRefunded) },
        { refundedAmount: round(alreadyRefunded + amount) },
        ['refundedAmount'],
      ),
    });

    this.notificationsService
      .notify({
        recipientId: order.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.REFUND_ISSUED,
        title: 'Refund issued',
        body: `You've been refunded ${amount} ${buyerCurrency} for order #${order.orderNumber}.`,
        data: { orderId },
      })
      .catch(() => {});

    return {
      success: true,
      message: 'Refund issued successfully',
      data: { orderId, amount, stripeRefundId },
    };
  }

  async getSellerReturns(sellerId: string, query: any) {
    const { orderModel, storeModel, userModel } =
      this.databaseService.repositories;
    const { storeId, status, page: pageStr } = query;

    const page = parseInt(pageStr) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    let storeIds: string[];

    if (storeId) {
      const store = await storeModel.findOne({
        _id: storeId,
        sellerId,
        isDelete: false,
      });
      if (!store)
        throw new ForbiddenException('Store not found or unauthorized');
      storeIds = [storeId];
    } else {
      const stores = await storeModel
        .find({ sellerId, isDelete: false })
        .select('_id')
        .lean();
      storeIds = (stores as any[]).map((s) => s._id.toString());
      if (storeIds.length === 0)
        throw new BadRequestException('No stores found for this seller');
    }

    const allOrders = await orderModel
      .find({ 'sellerOrders.storeId': { $in: storeIds }, isDelete: false })
      .lean();

    // flatten to individual return items
    const returnItems: { order: any; so: any; item: any }[] = [];
    let totalOrderItems = 0;

    for (const order of allOrders) {
      for (const so of order.sellerOrders) {
        if (!storeIds.includes(so.storeId)) continue;
        totalOrderItems += so.items.length;
        for (const item of so.items) {
          if (!item.returnStatus || item.returnStatus === 'none') continue;
          if (status && status !== 'all' && item.returnStatus !== status)
            continue;
          returnItems.push({ order, so, item });
        }
      }
    }

    // stats
    const openRequests = returnItems.filter(
      ({ item }) => item.returnStatus === 'requested',
    ).length;
    const returnRate =
      totalOrderItems > 0
        ? parseFloat(((returnItems.length / totalOrderItems) * 100).toFixed(1))
        : 0;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const totalRefunded = returnItems
      .filter(
        ({ item }) =>
          item.returnStatus === 'approved' &&
          item.returnRequestedAt &&
          new Date(item.returnRequestedAt) >= thirtyDaysAgo,
      )
      .reduce((sum, { item }) => sum + (item.refundedAmount || 0), 0);

    // paginate
    const total = returnItems.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = returnItems.slice(skip, skip + limit);

    const list = await Promise.all(
      paginated.map(async ({ order, so, item }) => {
        const user = await userModel
          .findById(order.userId)
          .select('name email contactEmail isGuest')
          .lean();
        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemId: item._id,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: buyerEmail(user as any),
          },
          storeId: so.storeId,
          productName: item.name,
          productImage: item.image || null,
          returnReason: item.returnReason,
          amount: item.totalPrice,
          refundedAmount: item.refundedAmount || 0,
          returnStatus: item.returnStatus,
          returnRejectReason: item.returnRejectReason || null,
          exchangeOrderId: item.exchangeOrderId ?? null,
          exchangeOrderNumber: item.exchangeOrderNumber ?? null,
          quantity: item.quantity,
          variantId: item.variantId ?? null,
          returnRequestedAt: item.returnRequestedAt,
        };
      }),
    );

    return {
      success: true,
      data: {
        stats: {
          openRequests,
          returnRate: `${returnRate}%`,
          totalRefunded,
        },
        pagination: { page, limit, totalPages, total },
        returns: list,
      },
    };
  }

  async returnRequest(userId: string, orderId: string, body: any, storeId: string) {
    const { reason, itemIds } = body;
    if (!reason) throw new BadRequestException('reason is required');

    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({
      _id: orderId,
      userId,
      isDelete: false,
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.orderStatus === 'cancelled')
      throw new BadRequestException('Cancelled orders cannot be returned');
    if (['pending', 'processing'].includes(order.orderStatus))
      throw new BadRequestException('Order not yet delivered');

    const now = new Date();

    // Scoped to THIS store's sellerOrder(s) only — a return request must
    // never be raised against another store's items within the same
    // (possibly multi-store legacy) order.
    const allItems: {
      soIndex: number;
      itemIndex: number;
      item: any;
      so: any;
    }[] = [];
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      if (so.storeId !== storeId) return;
      so.items.forEach((item: any, itemIndex: number) => {
        allItems.push({ soIndex, itemIndex, item, so });
      });
    });
    if (allItems.length === 0) throw new NotFoundException('Order not found');

    let targetItems: typeof allItems;

    if (itemIds && Array.isArray(itemIds) && itemIds.length > 0) {
      targetItems = [];
      for (const itemId of itemIds) {
        const found = allItems.find(
          ({ item }) => item._id.toString() === itemId,
        );
        if (!found) throw new BadRequestException(`Item not found: ${itemId}`);
        targetItems.push(found);
      }
    } else {
      targetItems = [...allItems];
    }

    for (const { item, so } of targetItems) {
      if (item.type === 'digital')
        throw new BadRequestException(
          `"${item.name}" is a digital product — cannot be returned`,
        );
      if (!['delivered', 'completed'].includes(so.status))
        throw new BadRequestException(`"${item.name}" is not yet delivered`);
      if (item.status === 'cancelled')
        throw new BadRequestException(
          `Cancelled item "${item.name}" cannot be returned`,
        );
      if (item.returnStatus && item.returnStatus !== 'none')
        throw new BadRequestException(
          `Return already requested for "${item.name}"`,
        );
    }

    const updateData: any = {};

    for (const { soIndex, itemIndex } of targetItems) {
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnStatus`] =
        'requested';
      updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnReason`] =
        reason;
      updateData[
        `sellerOrders.${soIndex}.items.${itemIndex}.returnRequestedAt`
      ] = now;
    }

    // sellerOrder returnStatus recalculate
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      const physicalActive = so.items.filter(
        (i: any) => i.type === 'physical' && i.status !== 'cancelled',
      );
      if (physicalActive.length === 0) return;

      const effectiveStatuses = physicalActive.map((item: any) => {
        const globalIdx = so.items.indexOf(item);
        const wasUpdated = targetItems.find(
          (t) => t.soIndex === soIndex && t.itemIndex === globalIdx,
        );
        return wasUpdated ? 'requested' : item.returnStatus || 'none';
      });

      const allRequested = effectiveStatuses.every(
        (s: string) => s === 'requested',
      );
      const anyRequested = effectiveStatuses.some(
        (s: string) => s === 'requested',
      );

      if (allRequested)
        updateData[`sellerOrders.${soIndex}.returnStatus`] = 'requested';
      else if (anyRequested)
        updateData[`sellerOrders.${soIndex}.returnStatus`] =
          'partial_requested';
    });

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    const notifiedSellers = new Set<string>();
    for (const { so } of targetItems) {
      if (!so.sellerId || notifiedSellers.has(so.sellerId)) continue;
      notifiedSellers.add(so.sellerId);
      this.notificationsService
        .notify({
          recipientId: so.sellerId,
          recipientRole: 'seller',
          storeId: so.storeId,
          type: NOTIFICATION_TYPES.REFUND_REQUESTED,
          title: 'Refund requested',
          body: `A refund has been requested for order #${order.orderNumber}.`,
          data: { orderId, storeId: so.storeId },
        })
        .catch(() => {});
    }

    return {
      success: true,
      message: `Return requested for ${targetItems.length} item(s)`,
      data: { orderId, requestedItems: targetItems.length },
    };
  }

  async returnAction(
    sellerId: string,
    orderId: string,
    body: any,
    ip?: string,
    userAgent?: string,
  ) {
    const { storeId, itemIds, action, rejectReason, restockDecisions } = body;
    if (!storeId) throw new BadRequestException('storeId is required');
    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0)
      throw new BadRequestException('itemIds are required');
    if (!action || !['approve', 'reject'].includes(action))
      throw new BadRequestException('action must be approve or reject');

    const { orderModel, storeModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const soIndex = order.sellerOrders.findIndex(
      (so: any) => so.storeId === storeId,
    );
    if (soIndex === -1)
      throw new BadRequestException('No orders found for this store');

    const sellerOrder = order.sellerOrders[soIndex];
    const updateData: any = {};
    const targetItems: { itemIndex: number; item: any }[] = [];

    for (const itemId of itemIds) {
      const itemIndex = sellerOrder.items.findIndex(
        (i: any) => i._id.toString() === itemId,
      );
      if (itemIndex === -1)
        throw new BadRequestException(`Item not found: ${itemId}`);
      const item = sellerOrder.items[itemIndex];
      if (item.returnStatus !== 'requested')
        throw new BadRequestException(
          `"${item.name}" has no pending return request`,
        );
      targetItems.push({ itemIndex, item });
    }

    for (const { itemIndex, item } of targetItems) {
      if (action === 'approve') {
        updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnStatus`] =
          'approved';
        updateData[
          `sellerOrders.${soIndex}.items.${itemIndex}.refundedAmount`
        ] = item.totalPrice;
      } else {
        updateData[`sellerOrders.${soIndex}.items.${itemIndex}.returnStatus`] =
          'rejected';
        if (rejectReason) {
          updateData[
            `sellerOrders.${soIndex}.items.${itemIndex}.returnRejectReason`
          ] = rejectReason;
        }
      }
    }

    // sellerOrder returnStatus recalculate
    const physicalActive = sellerOrder.items.filter(
      (item: any) => item.type === 'physical' && item.status !== 'cancelled',
    );

    const effectiveStatuses = physicalActive.map((item: any) => {
      const globalIdx = sellerOrder.items.indexOf(item);
      const wasUpdated = targetItems.find((t) => t.itemIndex === globalIdx);
      if (!wasUpdated) return item.returnStatus || 'none';
      return action === 'approve' ? 'approved' : 'rejected';
    });

    const allApproved = effectiveStatuses.every(
      (s: string) => s === 'approved',
    );
    const anyApproved = effectiveStatuses.some((s: string) => s === 'approved');
    const allRequested = effectiveStatuses.every(
      (s: string) => s === 'requested',
    );
    const anyRequested = effectiveStatuses.some(
      (s: string) => s === 'requested',
    );
    const allRejected = effectiveStatuses
      .filter((s: string) => s !== 'none')
      .every((s: string) => s === 'rejected');

    let newSellerReturnStatus: string;
    if (allApproved) newSellerReturnStatus = 'approved';
    else if (anyApproved)
      newSellerReturnStatus = 'partial_approved'; // approved wins even if kuch rejected
    else if (allRequested) newSellerReturnStatus = 'requested';
    else if (anyRequested) newSellerReturnStatus = 'partial_requested';
    else if (allRejected) newSellerReturnStatus = 'rejected';
    else newSellerReturnStatus = 'none';

    updateData[`sellerOrders.${soIndex}.returnStatus`] = newSellerReturnStatus;

    if (action === 'approve') {
      updateData.hasReturnApproved = true;
    }

    // Money first comes out of the ONE shared refund budget (clamped to what is left — part of these items may already have
    // been refunded another way), then the order is claimed with an optimistic lock so a double-click / two reviewers can't
    // both approve (and both refund) the same return.
    let grantedRefund = 0;
    if (action === 'approve' && order.isPaid) {
      const wanted = targetItems.reduce((sum, t) => sum + (t.item.totalPrice || 0) + (t.item.taxUSD || 0), 0);
      grantedRefund = await reserveRefundCapacity(orderModel, orderId, soIndex, wanted, { clamp: true });
    }
    const claimedReturn = await orderModel.findOneAndUpdate({ _id: orderId, updatedAt: (order as any).updatedAt }, { $set: updateData });
    if (!claimedReturn) {
      await releaseRefundCapacity(orderModel, orderId, soIndex, grantedRefund).catch(() => undefined);
      throw new BadRequestException('This order was just modified by someone else — please refresh and try again.');
    }

    let refundProcessed = false;
    if (action === 'approve' && order.isPaid) {
      // buyerRefundAmount is in the order's own charge currency; the
      // seller's wallet must be debited in THEIR settlement currency (same
      // conversion refund-request.service.ts's approve() already does) —
      // previously this passed the raw order-currency amount straight into
      // recordRefund with zero conversion, silently mis-debiting any seller
      // whose settlement currency differs from the buyer's charge currency.
      // Includes each item's own taxUSD share — see the cancellation path's
      // identical fix above for why (item price + its tax must be refunded
      // and clawed back from the seller together).
      const buyerRefundAmount = grantedRefund;
      if (buyerRefundAmount > 0) {
        const buyerCurrency = order.currency || 'USD';
        const settlementCurrency =
          sellerOrder.settlementCurrency ?? buyerCurrency;
        const sellerDebitAmount = this.exchangeRateService.convertWithSnapshots(
          buyerRefundAmount,
          buyerCurrency,
          settlementCurrency,
          order.fxSnapshots ?? [],
        );
        try {
          await this.financeService.recordRefund(
            storeId,
            sellerId,
            orderId,
            sellerDebitAmount,
            sellerId,
            'seller',
            {
              description: `Return approved — Order #${order.orderNumber}`,
              targetType: 'order',
              currency: settlementCurrency,
            },
          );
          refundProcessed = true;
        } catch (e: any) {
          console.error('Finance recordRefund failed:', e?.message);
        }

        // Real buyer-facing Stripe refund — previously this ONLY debited the
        // seller's wallet and never refunded the buyer's card at all, a
        // genuine money-leak: the seller paid for a return the buyer never
        // actually got their money back for. Mirrors
        // refund-request.service.ts's approve() exactly.
        if (order.paymentType === 'stripe') {
          const transaction =
            await this.databaseService.repositories.paymentTransactionModel.findOne(
              {
                orderIds: orderId,
                status: 'completed',
                isDelete: false,
              },
            );
          if (transaction?.stripePaymentIntentId) {
            try {
              await this.paymentService.refundStripePaymentIntent(
                transaction.stripePaymentIntentId,
                buyerRefundAmount,
                `return_action_${orderId}_${Date.now()}`,
              );
            } catch (e: any) {
              await this.activityLogService.log({
                storeId: 'platform',
                category: 'finance',
                action: 'stripe_refund_failed_after_ledger_reversal',
                description: `Stripe refund failed for order #${order.orderNumber} after seller ledger was already reversed (return approval): ${e?.message}`,
                actorId: sellerId,
                actorRole: 'seller',
                isSecurityAlert: true,
                targetId: orderId,
                targetType: 'order',
              });
            }
          }
        }

        this.loyaltyService
          .clawbackPurchasePoints(
            storeId,
            order.userId,
            orderId,
            buyerRefundAmount,
          )
          .catch(() => {});
      }

      // Gift-card balance reversal — mirrors executeCancellation's own
      // reversal; a return is a refund too, so a gift card applied at
      // checkout must come back the same way.
      if (order.giftCardCode) {
        const giftCardReverseAmount = targetItems.reduce(
          (sum, t) => sum + (t.item.giftCardDiscountUSD || 0),
          0,
        );
        if (giftCardReverseAmount > 0) {
          await this.giftCardsService.restoreOnRefund(
            storeId,
            order.giftCardCode,
            giftCardReverseAmount,
            orderId,
            `return:${orderId}:${targetItems.map((t) => t.item._id.toString()).sort().join(',')}`,
            `Order #${order.orderNumber} — return approved`,
          ).catch((e: any) => console.error('Gift card reversal failed (return approval):', e?.message));
        }
      }

      // Store-credit reversal — same reasoning as the gift card above.
      {
        const storeCreditReverseAmount = targetItems.reduce(
          (sum, t) => sum + (t.item.storeCreditDiscountUSD || 0),
          0,
        );
        if (storeCreditReverseAmount > 0) {
          await this.storeCreditService.restoreOnRefund(
            storeId,
            order.userId,
            storeCreditReverseAmount,
            orderId,
            `return:${orderId}:${targetItems.map((t) => t.item._id.toString()).sort().join(',')}`,
            `Order #${order.orderNumber} — return approved`,
          ).catch((e: any) => console.error('Store credit reversal failed (return approval):', e?.message));
        }
      }

      // Reverse Inventory link — every item reaching this point was already
      // delivered/shipped (a return can only be requested after that), so
      // real `stock` was already decremented for good at fulfillment time
      // (see ProductVariant.committedStock's doc comment) — restocking here
      // is a genuine physical-goods-coming-back credit, never touching the
      // reservation math a pre-shipment cancellation uses instead.
      // `restockDecisions` (an optional `{ [itemId]: 'restock'|'damaged' }`
      // map on the request body, keyed by the same OrderItem ids as
      // `itemIds`) is entirely opt-in — omit it and stock is left exactly
      // as untouched as before this existed, matching the seller's Returns
      // page not sending it yet unless updated to do so. 'restock' credits
      // real sellable `stock` back; 'damaged' credits `damagedStock`
      // instead — still genuinely on-hand, never sellable (see that
      // field's own doc comment) — mirroring PurchaseOrdersService's
      // identical bucket for damaged-on-arrival PO receipts.
      if (restockDecisions && typeof restockDecisions === 'object') {
        const { productVariantModel, stockAdjustmentModel, sellerModel } = this.databaseService.repositories;
        const seller = await sellerModel.findOne({ _id: sellerId }).select('name');
        for (const { item } of targetItems) {
          const decision = restockDecisions[item._id.toString()];
          if (item.type !== 'physical' || !item.variantId || (decision !== 'restock' && decision !== 'damaged')) continue;
          const variant = await productVariantModel.findOne({ _id: item.variantId, isDelete: false });
          if (!variant || variant.unlimitedStock) continue;
          const qty = item.quantity;
          const previousStock = variant.stock;
          await productVariantModel.updateOne(
            { _id: item.variantId },
            decision === 'restock' ? { $inc: { stock: qty } } : { $inc: { stock: qty, damagedStock: qty } },
          );
          await stockAdjustmentModel.create({
            storeId, productId: item.productId, variantId: item.variantId, locationId: null,
            productName: item.name, sku: item.sku ?? null,
            previousStock, newStock: previousStock + qty, delta: qty,
            reason: decision === 'restock' ? 'return' : 'damaged',
            note: `Return for order #${order.orderNumber}`,
            adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
          });
        }
      }
    }

    this.activityLogService.log({
      storeId,
      category: 'orders',
      action: action === 'approve' ? 'return_approved' : 'return_rejected',
      description: `Order #${orderId} — ${targetItems.length} item(s) return ${action === 'approve' ? 'approved' : 'rejected'}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
      ip,
      userAgent,
    });

    return {
      success: true,
      message:
        action === 'approve'
          ? `Return approved for ${targetItems.length} item(s)`
          : `Return rejected for ${targetItems.length} item(s)`,
      data: {
        orderId,
        action,
        processedItems: targetItems.length,
        refundProcessed,
      },
    };
  }

  async downloadByToken(token: string) {
    let payload: any;
    try {
      payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new BadRequestException('Download link expired or invalid');
    }

    const { userId, orderId, productId, fileIndex } = payload;
    const { orderModel, productModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid');

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product?.digital?.files?.length)
      throw new NotFoundException('Product files not found');

    const file = product.digital.files[fileIndex];
    if (!file) throw new NotFoundException('File not found');

    // download limit check
    const downloadLimit = product.digital?.downloadLimit;
    if (downloadLimit && downloadLimit !== 'unlimited') {
      const limitNum = parseInt(downloadLimit);

      // order mein is product ka downloadCount nikalo
      let currentCount = 0;
      let sellerOrderIndex = -1;
      let itemIndex = -1;

      for (let si = 0; si < order.sellerOrders.length; si++) {
        const so = order.sellerOrders[si];
        for (let ii = 0; ii < so.items.length; ii++) {
          if (so.items[ii].productId === productId) {
            currentCount = so.items[ii].downloadCount || 0;
            sellerOrderIndex = si;
            itemIndex = ii;
            break;
          }
        }
      }

      if (currentCount >= limitNum) {
        throw new BadRequestException(
          `Download limit reached (${limitNum}/${limitNum})`,
        );
      }

      // count increment
      const updatePath = `sellerOrders.${sellerOrderIndex}.items.${itemIndex}.downloadCount`;
      await orderModel.findByIdAndUpdate(orderId, {
        $inc: { [updatePath]: 1 },
      });
    }

    const mimeType = this.uploadService.resolveMimeType(
      file.name,
      file.mimeType ?? 'application/octet-stream',
    );
    const resourceType = mimeType.startsWith('video/')
      ? 'video'
      : mimeType.startsWith('image/')
        ? 'image'
        : 'raw';
    const signedUrl = this.uploadService.generateSignedUrl(
      file.url,
      resourceType,
      300,
    );

    const response = await fetch(signedUrl);
    if (!response.ok)
      throw new BadRequestException('Failed to fetch file from storage');

    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), fileName: file.name, mimeType };
  }

  /** Called once daily by SchedulerService (`runLocked`) — real automated
   *  dunning for a completed Order carrying real payment terms (converted
   *  from a Draft Order fulfilled now, invoiced later — see
   *  Order.paymentTerms's doc comment) whose `dueDate` has passed while
   *  still unpaid. Unlike an open Draft Order's invoice (see
   *  DraftOrdersService.sendOverdueInvoiceReminders), a completed Order has
   *  no live online-payment link to re-send — the seller is the one who has
   *  to actually chase payment (bank transfer, in-person, etc.), so this
   *  notifies the seller only. One reminder per overdue order, deduped via
   *  `overdueReminderSentAt`. */
  async sendOverdueOrderReminders(): Promise<void> {
    const { orderModel } = this.databaseService.repositories;
    const overdue = await orderModel
      .find({
        paymentTerms: { $ne: null },
        isPaid: false,
        dueDate: { $lt: new Date() },
        overdueReminderSentAt: null,
      })
      .select('orderNumber sellerOrders totalAmount currency dueDate')
      .lean();

    for (const order of overdue as any[]) {
      // Notify each distinct seller/store pair this order actually belongs
      // to (a draft-order-converted order is always single-seller, but this
      // stays correct for any future multi-seller order that ever carries
      // payment terms too) — paired from the real sellerOrders, not two
      // independently-deduped arrays that could misalign.
      const seenPairs = new Set<string>();
      const amount = order.totalAmount ?? 0;
      const symbol = order.currency === 'PKR' ? 'Rs. ' : order.currency === 'USD' ? '$' : `${order.currency} `;

      for (const so of order.sellerOrders) {
        const pairKey = `${so.sellerId}:${so.storeId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        await this.notificationsService.notify({
          recipientId: so.sellerId, recipientRole: 'seller', storeId: so.storeId,
          type: NOTIFICATION_TYPES.ORDER_PAYMENT_OVERDUE,
          title: 'Order payment overdue',
          body: `Order ${order.orderNumber} (${symbol}${amount}) was due ${new Date(order.dueDate).toLocaleDateString()} and is still unpaid.`,
          data: { orderId: order._id.toString(), link: `/store/${so.storeId}/orders/${order._id.toString()}` },
        });
      }

      await orderModel.updateOne({ _id: order._id }, { $set: { overdueReminderSentAt: new Date() } });
    }
  }
}
