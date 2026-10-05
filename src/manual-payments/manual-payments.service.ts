/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { UploadService } from '@/upload/upload.service';
import { PaymentService } from '@/payment/payment.service';
import { FinanceService } from '@/finance/finance.service';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { round } from '@/common/number.util';
import { fulfilStockForSellerOrders } from '@/common/fulfil-stock.util';
import { SubmitManualPaymentDto } from './dto/submit-manual-payment.dto';
import { ReuploadManualPaymentDto } from './dto/reupload-manual-payment.dto';

/** Mirrors OrdersService's local `sellerPayoutBasis`/`sellerPayoutCurrency` —
 *  settlement must always be computed and labeled in the SELLER'S OWN
 *  currency (so.settlementCurrency), independent of `order.currency` (the
 *  buyer's paid currency, which for every manual-bank-transfer order is
 *  forced to 'PKR' regardless of the seller's actual store currency — see
 *  PaymentService.manualBankTransferPayment). Falls back to the old
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
export class ManualPaymentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly uploadService: UploadService,
    private readonly paymentService: PaymentService,
    private readonly financeService: FinanceService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get proofModel() { return this.db.repositories.manualPaymentProofModel; }
  private get orderModel() { return this.db.repositories.orderModel; }
  private get storeModel() { return this.db.repositories.storeModel; }
  private get storeIntegrationModel() { return this.db.repositories.storeIntegrationModel; }

  /** The seller's own bank account for this store — see StoreIntegrationsService's 'bank_transfer' provider. */
  async getBankDetails(storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');
    const integration = await this.storeIntegrationModel.findOne({
      storeId, type: 'payment', provider: 'bank_transfer', isEnabledForCheckout: true,
    }).lean();
    if (!integration) {
      throw new BadRequestException('Bank transfer payment is not available right now.');
    }
    const config = integration.config ?? {};
    // `usdToPkrRate` is included so the app can show "you'll transfer approximately
    // PKR X" before the buyer commits — the authoritative amount is computed
    // (and locked in) server-side at submission time in `submitPayment`.
    const rate = await this.exchangeRateService.getCurrentRate('PKR');
    return {
      bankName: config.bankName,
      accountTitle: config.accountTitle,
      accountNumber: config.accountNumber,
      iban: config.iban,
      jazzcashNumber: config.jazzcashNumber,
      easypaisaNumber: config.easypaisaNumber,
      instructions: config.instructions,
      usdToPkrRate: rate?.ratePerUSD ?? null,
    };
  }

  /** Places the order(s) (unpaid, `pending_verification`) and attaches the buyer's uploaded proof in one step. */
  async submitPayment(userId: string, dto: SubmitManualPaymentDto, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');

    const { orders, amountUSD, amountPKR, fxRate } = await this.paymentService.manualBankTransferPayment(userId, dto.checkoutId);
    const upload = await this.uploadService.uploadFile(file);

    const storeIdSet = new Set<string>();
    for (const o of orders as any[]) {
      for (const so of (o.sellerOrders ?? []) as any[]) {
        storeIdSet.add(String(so.storeId));
      }
    }
    const storeIds: string[] = Array.from(storeIdSet);

    const proof = await this.proofModel.create({
      userId,
      checkoutId: dto.checkoutId,
      orderIds: (orders as any[]).map((o: any) => o._id.toString()),
      storeIds,
      amountUSD,
      amountPKR,
      fxRateUsed: fxRate,
      proofImageUrl: upload.url,
      transactionReference: dto.transactionReference ?? null,
      senderName: dto.senderName ?? null,
      status: 'pending',
    });

    this.notificationsService
      .notify({
        recipientId: userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.MANUAL_PAYMENT_SUBMITTED,
        title: 'Payment proof received',
        body: `We've received your transfer proof for PKR ${amountPKR.toFixed(2)} — we're verifying it now.`,
        data: { proofId: proof._id.toString(), orderIds: proof.orderIds },
      })
      .catch(() => {});

    return {
      proof,
      orders: orders.map((o: any) => ({ orderId: o._id, orderNumber: o.orderNumber, totalAmount: o.totalAmount, currency: o.currency })),
      message: "We're verifying your payment — you'll be notified once it's confirmed.",
    };
  }

  /** After a rejection, the buyer can try again with a fresh screenshot/reference without re-placing the order. */
  async reuploadPayment(userId: string, proofId: string, dto: ReuploadManualPaymentDto, file: Express.Multer.File | undefined) {
    const proof = await this.proofModel.findOne({ _id: proofId, userId });
    if (!proof) throw new NotFoundException('Payment proof not found');
    if (proof.status !== 'rejected') {
      throw new BadRequestException(`Cannot re-upload — this proof is currently "${proof.status}"`);
    }
    if (!file) throw new BadRequestException('A payment proof image (screenshot or receipt) is required');

    const upload = await this.uploadService.uploadFile(file);

    proof.proofImageUrl = upload.url;
    proof.transactionReference = dto.transactionReference ?? proof.transactionReference;
    proof.senderName = dto.senderName ?? proof.senderName;
    proof.status = 'pending';
    proof.rejectionReason = null;
    proof.reviewedByAdminId = null;
    proof.reviewedAt = null;
    proof.reuploadCount = (proof.reuploadCount ?? 0) + 1;
    await proof.save();

    return proof;
  }

  async getProofStatus(userId: string, proofId: string, storeId?: string) {
    const proof = await this.proofModel
      .findOne({ _id: proofId, userId, ...(storeId ? { storeIds: storeId } : {}) })
      .lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return proof;
  }

  async getMyProofs(userId: string, storeId?: string) {
    return this.proofModel
      .find({ userId, ...(storeId ? { storeIds: storeId } : {}) })
      .sort({ createdAt: -1 })
      .lean();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SELLER — this store's own pending manual-payment-proof queue
  // ═══════════════════════════════════════════════════════════════════════

  async sellerListQueue(storeId: string, sellerId: string, query: any) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);

    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = { storeIds: storeId };
    if (query.status) filter.status = query.status;

    const [proofs, total] = await Promise.all([
      this.proofModel.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean(),
      this.proofModel.countDocuments(filter),
    ]);

    const userIds = [...new Set((proofs as any[]).map((p) => p.userId))];
    const users = await this.db.repositories.userModel.find({ _id: { $in: userIds } }).select('name email').lean();
    const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

    return {
      proofs: (proofs as any[]).map((p) => ({
        ...p,
        buyerName: userMap.get(p.userId)?.name ?? 'Unknown buyer',
        buyerEmail: userMap.get(p.userId)?.email ?? '',
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    };
  }

  async sellerGetById(storeId: string, sellerId: string, proofId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const proof = await this.proofModel.findOne({ _id: proofId, storeIds: storeId }).lean();
    if (!proof) throw new NotFoundException('Payment proof not found');
    return proof;
  }

  async sellerApprove(storeId: string, sellerId: string, proofId: string, ip?: string, userAgent?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const proof = await this.proofModel.findOne({ _id: proofId, storeIds: storeId });
    if (!proof) throw new NotFoundException('Payment proof not found');
    if (proof.status !== 'pending') {
      throw new BadRequestException(`Cannot approve a proof with status "${proof.status}"`);
    }

    const orders = await this.orderModel.find({ _id: { $in: proof.orderIds }, isDelete: false });
    if (orders.length === 0) throw new NotFoundException('No orders found for this payment proof');
    // A cancelled/refunded order must never be revived into "paid + completed"
    // (that completes every sub-order and credits the ledger).
    const dead = ['cancelled', 'refunded'];
    if ((orders as any[]).some((o) => dead.includes(o.orderStatus) || (o.sellerOrders ?? []).some((so: any) => dead.includes(so.status)))) {
      throw new BadRequestException('This proof covers an order that was cancelled or refunded — it cannot be approved. Reject the proof instead.');
    }

    const now = new Date();
    for (const order of orders as any[]) {
      await fulfilStockForSellerOrders(this.db.repositories.productVariantModel, order.sellerOrders);
      const updateData: Record<string, any> = {
        isPaid: true,
        paymentStatus: 'paid',
        paidAt: now,
        orderStatus: 'completed',
      };
      order.sellerOrders.forEach((so: any, soIndex: number) => {
        updateData[`sellerOrders.${soIndex}.status`] = 'completed';
        updateData[`sellerOrders.${soIndex}.deliveredAt`] = now;
        so.items.forEach((_: any, itemIndex: number) => {
          updateData[`sellerOrders.${soIndex}.items.${itemIndex}.status`] = 'completed';
        });
      });
      await this.orderModel.findByIdAndUpdate(order._id, { $set: updateData });

      for (const so of order.sellerOrders) {
        const platformSponsoredUSD = so.platformSponsoredDiscountUSD ?? 0;
        const sponsoredCampaignId = so.items.find((i: any) => i.campaignSponsorType === 'platform')?.campaignId ?? null;
        try {
          await this.financeService.recordSale(
            so.storeId, so.sellerId, order._id.toString(), sellerPayoutBasis(so),
            `Sale — Order #${order._id} (manual bank transfer, verified)`,
            platformSponsoredUSD, sponsoredCampaignId, sellerPayoutCurrency(so, order),
            order.paymentType || 'manual_bank_transfer',
          );
        } catch (e: any) {
          console.error('Finance recordSale failed (manual payment approval):', e?.message);
        }
      }
    }

    proof.status = 'approved';
    // Field name predates the per-store rework — now holds the reviewing seller's id, not an admin's.
    proof.reviewedByAdminId = sellerId;
    proof.reviewedAt = now;
    await proof.save();

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'manual_payment_approved',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} approved for ${orders.length} order(s)`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: proofId,
      targetType: 'manual_payment_proof',
      ip, userAgent,
    });

    this.notificationsService
      .notify({
        recipientId: proof.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.MANUAL_PAYMENT_APPROVED,
        title: 'Payment confirmed',
        body: 'Your bank transfer has been verified — your order is now confirmed.',
        data: { proofId, orderIds: proof.orderIds },
      })
      .catch(() => {});

    return proof;
  }

  async sellerReject(storeId: string, sellerId: string, proofId: string, reason: string, ip?: string, userAgent?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const proof = await this.proofModel.findOne({ _id: proofId, storeIds: storeId });
    if (!proof) throw new NotFoundException('Payment proof not found');
    if (proof.status !== 'pending') {
      throw new BadRequestException(`Cannot reject a proof with status "${proof.status}"`);
    }

    proof.status = 'rejected';
    proof.rejectionReason = reason;
    proof.reviewedByAdminId = sellerId;
    proof.reviewedAt = new Date();
    await proof.save();

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'manual_payment_rejected',
      description: `Manual bank-transfer payment of PKR ${proof.amountPKR.toFixed(2)} rejected — ${reason}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: proofId,
      targetType: 'manual_payment_proof',
      ip, userAgent,
    });

    this.notificationsService
      .notify({
        recipientId: proof.userId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.MANUAL_PAYMENT_REJECTED,
        title: 'Payment could not be verified',
        body: `We couldn't verify your transfer: ${reason}. You can re-upload your proof or cancel the order.`,
        data: { proofId, orderIds: proof.orderIds, reason },
      })
      .catch(() => {});

    return proof;
  }
}
