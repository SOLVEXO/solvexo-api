import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { UploadService } from 'src/upload/upload.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FinanceService } from 'src/finance/finance.service';
import { PaymentService } from 'src/payment/payment.service';
import { ExchangeRateService } from 'src/exchange-rate/exchange-rate.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { round } from 'src/common/number.util';
import { deriveRollupStatus } from './order-status.util';
import { toCsv } from 'src/analytics/utils/csv.util';

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
  return round(so.subtotal + (so.platformSponsoredDiscountUSD ?? 0));
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
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /** Subscribers earn points at their plan's configured multiplier (default 1x). */
  private async awardLoyaltyPointsWithMultiplier(
    storeId: string,
    userId: string,
    orderId: string,
    subtotal: number,
  ) {
    const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(
      userId,
      storeId,
    );
    const multiplier = benefitsEntry
      ? this.subscriptionBenefits.getLoyaltyMultiplier(benefitsEntry.benefits)
      : 1;
    return this.loyaltyService.awardPurchasePoints(
      storeId,
      userId,
      orderId,
      subtotal,
      multiplier,
    );
  }

  async getOrdersByUserId(userId: string, query: any) {
    const { orderModel, sellerModel, ratingModel } =
      this.databaseService.repositories;

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 10;
    const skip = (page - 1) * limit;

    const filter: any = { userId, isDelete: false };

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
      stores: (order.sellerOrders ?? []).map((so: any) => {
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
            isReviewed: reviewedProductIds.has(item.productId),
          })),
          tracking: so.tracking,
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

  async getOrderById(userId: string, orderId: string) {
    const { orderModel, sellerModel } = this.databaseService.repositories;

    const order = await orderModel
      .findOne({ _id: orderId, isDelete: false })
      .lean();
    if (!order) throw new NotFoundException('Order not found');
    if ((order as any).userId !== userId)
      throw new ForbiddenException('Unauthorized');

    const orderSellerOrders = ((order as any).sellerOrders ?? []) as any[];
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
      data: enrichedOrder,
    };
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
    if (query.userId) {
      matchFilter.userId = query.userId;
    }
    if (query.type && query.type !== 'all') {
      matchFilter['sellerOrders.fulfillmentType'] = query.type;
    }
    if (query.status && query.status !== 'all') {
      matchFilter['sellerOrders.status'] = query.status;
    }
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

    const totalOrders = await orderModel.countDocuments(matchFilter);
    const totalPages = Math.ceil(totalOrders / limit);

    const orders = await orderModel
      .find(matchFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // stats — all orders across the scoped store(s) (no pagination)
    const allOrders = await orderModel
      .find({ 'sellerOrders.storeId': { $in: storeIds }, isDelete: false })
      .lean();

    let totalRevenue = 0;
    let pendingCount = 0;

    for (const order of allOrders) {
      const so = (order.sellerOrders as any[]).find((s: any) =>
        storeIds.includes(s.storeId),
      );
      if (!so) continue;
      if (['completed', 'delivered'].includes(so.status)) {
        totalRevenue += so.subtotal || 0;
      }
      if (['pending', 'processing'].includes(so.status)) {
        pendingCount++;
      }
    }

    const avgOrder = allOrders.length > 0 ? totalRevenue / allOrders.length : 0;

    // order rows format
    const rows = await Promise.all(
      orders.map(async (order: any) => {
        const so = order.sellerOrders.find((s: any) =>
          storeIds.includes(s.storeId),
        );
        if (!so) return null;

        const user = await userModel
          .findOne({ _id: order.userId })
          .select('name email')
          .lean();
        const firstItem = so.items?.[0];

        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: (user as any)?.email || '',
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
        buyer: {
          name: (buyer as any)?.name ?? 'Unknown',
          email: (buyer as any)?.email ?? '',
          phone: (buyer as any)?.phone ?? '',
        },
        // This store's own portion only — items, rollup status, tracking,
        // fulfillment timestamps, return status. `subtotal` here is already
        // scoped to this seller, unlike `order.subtotal` (the whole order).
        sellerOrder,
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
      .select('name email')
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

  async getDownloadUrls(userId: string, orderId: string, productId: string) {
    if (!orderId) throw new BadRequestException('orderId is required');
    if (!productId) throw new BadRequestException('productId is required');

    const { orderModel, productModel } = this.databaseService.repositories;

    // 1. order fetch + ownership
    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');

    // 2. payment check
    if (!order.isPaid) throw new BadRequestException('Order is not paid yet');

    // 3. product is in this order
    let targetItem: any = null;

    for (const so of order.sellerOrders) {
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

  async updateSellerOrderStatus(
    sellerId: string,
    body: any,
    ip?: string,
    userAgent?: string,
  ) {
    const { orderId, storeId, status, tracking } = body;

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

    // Guards against double-crediting the finance ledger if this sellerOrder was already
    // completed before this call (duplicate/retried request, double-click, etc.) — mirrors
    // the `order.isPaid` guard already used in `markPaid` below for the same reason.
    const wasAlreadyCompleted =
      order.sellerOrders[sellerOrderIndex].status === 'completed';

    if (status === 'shipped' && !tracking) {
      throw new BadRequestException(
        'tracking info required when status is shipped',
      );
    }

    const updateData: any = {};

    // sellerOrder status
    updateData[`sellerOrders.${sellerOrderIndex}.status`] = status;

    // saare items same status
    const soItems = order.sellerOrders[sellerOrderIndex].items;
    soItems.forEach((_: any, itemIndex: number) => {
      updateData[`sellerOrders.${sellerOrderIndex}.items.${itemIndex}.status`] =
        status;
    });

    // status-specific fields
    if (status === 'shipped') {
      updateData[`sellerOrders.${sellerOrderIndex}.shippedAt`] = new Date();
      updateData[`sellerOrders.${sellerOrderIndex}.tracking`] = tracking;
    }
    if (status === 'delivered') {
      updateData[`sellerOrders.${sellerOrderIndex}.deliveredAt`] = new Date();
    }

    // overall orderStatus derive — single source of truth, see
    // order-status.util.ts. Previously a hand-rolled if/else chain that fell
    // through silently (leaving `orderStatus` stale) for a status mix like
    // ['pending','processing'], which matched none of its three branches.
    const allStatuses = order.sellerOrders.map((so: any, idx: number) =>
      idx === sellerOrderIndex ? status : so.status,
    );
    updateData.orderStatus = deriveRollupStatus(allStatuses);

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

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

      this.awardLoyaltyPointsWithMultiplier(
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
      description: tracking
        ? `Order #${orderId} — shipped via ${tracking.carrier ?? tracking}`
        : `Order #${orderId} — status changed to ${status}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: orderId,
      targetType: 'order',
      ip,
      userAgent,
    });

    if (status === 'shipped' || status === 'delivered') {
      this.notificationsService
        .notify({
          recipientId: order.userId,
          recipientRole: 'user',
          type:
            status === 'shipped'
              ? NOTIFICATION_TYPES.ORDER_SHIPPED
              : NOTIFICATION_TYPES.ORDER_DELIVERED,
          title:
            status === 'shipped'
              ? 'Your order has shipped'
              : 'Your order was delivered',
          body:
            status === 'shipped'
              ? `Order #${orderId} is on its way${tracking?.carrier ? ` via ${tracking.carrier}` : ''}.`
              : `Order #${orderId} has been delivered.`,
          data: { orderId, status },
        })
        .catch(() => {});
    }

    return { success: true, message: `Order status updated to ${status}` };
  }

  async markPaid(orderId: string) {
    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.isPaid) throw new BadRequestException('Order is already paid');

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

      this.awardLoyaltyPointsWithMultiplier(
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

    return { success: true, message: 'Order marked as paid' };
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
    );
  }

  async streamStampedPdf(
    userId: string,
    orderId: string,
    productId: string,
    fileIndex: number,
  ) {
    const { orderModel, productModel, userModel } =
      this.databaseService.repositories;

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
  ) {
    const { orderModel, productModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) throw new ForbiddenException('Unauthorized');
    if (!order.isPaid) throw new BadRequestException('Order is not paid yet');

    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product?.digital?.files?.length)
      throw new NotFoundException('Product files not found');

    const file = product.digital.files[fileIndex];
    if (!file) throw new NotFoundException('File not found at this index');

    const token = this.jwtService.sign(
      { userId, orderId, productId, fileIndex },
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

  async cancelOrder(userId: string, orderId: string, body: any) {
    const { reason, itemIds } = body;
    if (!reason) throw new BadRequestException('reason is required');

    const { orderModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({
      _id: orderId,
      userId,
      isDelete: false,
    });
    if (!order) throw new NotFoundException('Order not found');

    return this.executeCancellation(order, itemIds, reason, {
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

      // physical item — stock wapas restore (skip unlimited-stock variants)
      if (item.type === 'physical' && item.variantId) {
        await productVariantModel.updateOne(
          { _id: item.variantId, unlimitedStock: { $ne: true } },
          { $inc: { stock: item.quantity } },
        );
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

    // ── Real money movement (paid orders only) ──────────────────────────
    let totalBuyerRefund = 0;
    if (order.isPaid) {
      updateData.paymentStatus = 'refunded';

      const amountBySoIndex = new Map<number, number>();
      for (const { soIndex, item } of targetItems) {
        amountBySoIndex.set(
          soIndex,
          (amountBySoIndex.get(soIndex) ?? 0) + item.totalPrice,
        );
      }
      const buyerCurrency = order.currency || 'USD';

      for (const [soIndex, amount] of amountBySoIndex) {
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
              `order_cancel_${orderId}_${now.getTime()}`,
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

    // Optimistic lock — this method now has TWO independent entry points
    // (`cancelOrder` for the buyer, `cancelOrderAsSeller` for the seller),
    // both computing `updateData` from the SAME `order` snapshot read at the
    // top of this function. Without this guard, a buyer and seller
    // cancelling different items on the same order at nearly the same
    // moment would race: the second write's `$set` (still built from its
    // own stale read) would silently clobber the first's already-applied
    // item/status/refund changes — a real correctness gap a plain
    // `findByIdAndUpdate` can't detect. Matching on the snapshot's own
    // `updatedAt` makes the write a no-op (rather than a silent overwrite)
    // if the order changed underneath it; the caller gets a clear,
    // retryable error instead of quietly losing the other actor's changes.
    const updated = await orderModel.findOneAndUpdate(
      { _id: orderId, updatedAt: order.updatedAt },
      { $set: updateData },
    );
    if (!updated) {
      throw new BadRequestException(
        'This order was just modified by someone else — please refresh and try again.',
      );
    }

    if (actor.notifyRecipientRole === 'seller') {
      const affectedSellerIds = [
        ...new Set(
          targetItems.map(
            ({ soIndex }) => order.sellerOrders[soIndex].sellerId,
          ),
        ),
      ];
      affectedSellerIds.forEach((recipientId) => {
        this.notificationsService
          .notify({
            recipientId,
            recipientRole: 'seller',
            type: NOTIFICATION_TYPES.ORDER_CANCELLED,
            title: actor.notifyTitle,
            body: actor.notifyBody(orderId),
            data: { orderId },
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
          .select('name email')
          .lean();
        return {
          orderId: order._id,
          orderNumber: order.orderNumber,
          itemId: item._id,
          customer: {
            name: (user as any)?.name || 'Unknown',
            email: (user as any)?.email || null,
          },
          storeId: so.storeId,
          productName: item.name,
          productImage: item.image || null,
          returnReason: item.returnReason,
          amount: item.totalPrice,
          refundedAmount: item.refundedAmount || 0,
          returnStatus: item.returnStatus,
          returnRejectReason: item.returnRejectReason || null,
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

  async returnRequest(userId: string, orderId: string, body: any) {
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

    const allItems: {
      soIndex: number;
      itemIndex: number;
      item: any;
      so: any;
    }[] = [];
    order.sellerOrders.forEach((so: any, soIndex: number) => {
      so.items.forEach((item: any, itemIndex: number) => {
        allItems.push({ soIndex, itemIndex, item, so });
      });
    });

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
    const { storeId, itemIds, action, rejectReason } = body;
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

    await orderModel.findByIdAndUpdate(orderId, { $set: updateData });

    let refundProcessed = false;
    if (action === 'approve' && order.isPaid) {
      // buyerRefundAmount is in the order's own charge currency; the
      // seller's wallet must be debited in THEIR settlement currency (same
      // conversion refund-request.service.ts's approve() already does) —
      // previously this passed the raw order-currency amount straight into
      // recordRefund with zero conversion, silently mis-debiting any seller
      // whose settlement currency differs from the buyer's charge currency.
      const buyerRefundAmount = targetItems.reduce(
        (sum, t) => sum + (t.item.totalPrice || 0),
        0,
      );
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
}
