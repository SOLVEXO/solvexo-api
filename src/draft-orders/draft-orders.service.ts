/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import Stripe from 'stripe';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { EmailService } from '../otp/services/email.service';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';
import { CommissionRulesService } from '../commission-rules/commission-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateDraftOrderDto } from './dto/create-draft-order.dto';
import { UpdateDraftOrderDto } from './dto/update-draft-order.dto';

function round(n: number) {
  return Math.round(n * 100) / 100;
}

const PAYMENT_TERMS_DAYS: Record<string, number> = {
  due_on_receipt: 0,
  net_15: 15,
  net_30: 30,
  net_60: 60,
};

/** Server-computed due date — never trusts a client-supplied date, matching
 *  every other derived-value convention in this app. */
function computeDueDate(paymentTerms: string | null | undefined, from: Date): Date | null {
  if (!paymentTerms || !(paymentTerms in PAYMENT_TERMS_DAYS)) return null;
  const due = new Date(from);
  due.setDate(due.getDate() + PAYMENT_TERMS_DAYS[paymentTerms]);
  return due;
}

@Injectable()
export class DraftOrdersService {
  private stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly stripeConnectService: StripeConnectService,
    private readonly commissionRulesService: CommissionRulesService,
    private readonly notificationsService: NotificationsService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    }
  }

  private get repos() {
    return this.databaseService.repositories;
  }

  private assertStripeConfigured(): InstanceType<typeof Stripe> {
    if (!this.stripe) {
      throw new BadRequestException('Online invoice payments are not configured yet.');
    }
    return this.stripe;
  }

  /** Resolves each line item against the real Product/Variant (name/sku/image/
   *  options/type snapshot + current price as the default), same "snapshot at
   *  the moment it's added" convention every other order-shaped document in
   *  this app already follows — never a live join read at display time. */
  private async resolveItems(storeId: string, items: { productId: string; variantId: string; quantity: number; unitPrice?: number }[]) {
    const resolved: any[] = [];
    for (const item of items) {
      const [product, variant] = await Promise.all([
        this.repos.productModel.findOne({ _id: item.productId, storeId, isDelete: { $ne: true } }).lean(),
        this.repos.productVariantModel.findOne({ _id: item.variantId, productId: item.productId, isDelete: false }).lean(),
      ]);
      if (!product || !variant) throw new BadRequestException(`Product or variant not found: ${item.productId}`);
      resolved.push({
        productId: item.productId,
        variantId: item.variantId,
        type: (product as any).type,
        name: (product as any).name,
        image: (product as any).images?.[0] ?? null,
        sku: (variant as any).sku ?? null,
        options: (variant as any).options ?? [],
        quantity: item.quantity,
        unitPrice: item.unitPrice ?? (variant as any).price,
      });
    }
    return resolved;
  }

  private recalculate(draft: { items: { unitPrice: number; quantity: number }[]; discountType: string | null; discountValue: number; shippingAmount: number; taxAmount: number }) {
    const subtotal = round(draft.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0));
    const discountAmount = round(
      draft.discountType === 'percentage' ? subtotal * ((draft.discountValue ?? 0) / 100)
      : draft.discountType === 'fixed' ? Math.min(draft.discountValue ?? 0, subtotal)
      : 0,
    );
    const total = round(Math.max(0, subtotal - discountAmount + (draft.shippingAmount ?? 0) + (draft.taxAmount ?? 0)));
    return { subtotal, discountAmount, total };
  }

  async create(storeId: string, sellerId: string, dto: CreateDraftOrderDto) {
    const store = await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const items = await this.resolveItems(storeId, dto.items);
    const base = {
      discountType: dto.discountType ?? null,
      discountValue: dto.discountValue ?? 0,
      shippingAmount: dto.shippingAmount ?? 0,
      taxAmount: dto.taxAmount ?? 0,
    };
    const { subtotal, discountAmount, total } = this.recalculate({ items, ...base });

    const draft = await this.repos.draftOrderModel.create({
      storeId,
      sellerId,
      customerId: dto.customerId ?? null,
      customerName: dto.customerName,
      customerEmail: dto.customerEmail ?? null,
      customerPhone: dto.customerPhone ?? null,
      items,
      ...base,
      notes: dto.notes ?? '',
      currency: store.baseCurrency ?? 'PKR',
      subtotal, discountAmount, total,
      status: 'open',
      shippingAddress: dto.shippingAddress ?? null,
      paymentTerms: dto.paymentTerms ?? null,
      dueDate: computeDueDate(dto.paymentTerms, new Date()),
    });

    await this.activityLogService.log({
      storeId, category: 'orders', action: 'draft_order_created',
      description: `Draft order created for ${dto.customerName}`,
      actorId: sellerId, actorRole: 'seller', targetId: draft._id.toString(), targetType: 'draft_order',
    });

    return draft.toObject();
  }

  async list(storeId: string, sellerId: string, query: { status?: string; page?: number; limit?: number }) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const filter: Record<string, any> = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    const [items, total] = await Promise.all([
      this.repos.draftOrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.repos.draftOrderModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  private async getOwned(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const draft = await this.repos.draftOrderModel.findOne({ _id: id, storeId, isDelete: false }).lean();
    if (!draft) throw new NotFoundException('Draft order not found');
    return draft;
  }

  async getById(storeId: string, sellerId: string, id: string) {
    return this.getOwned(storeId, sellerId, id);
  }

  async update(storeId: string, sellerId: string, id: string, dto: UpdateDraftOrderDto) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('Only an open draft order can be edited.');

    const items = dto.items ? await this.resolveItems(storeId, dto.items) : draft.items;
    const merged = {
      discountType: dto.discountType !== undefined ? dto.discountType : draft.discountType,
      discountValue: dto.discountValue !== undefined ? dto.discountValue : draft.discountValue,
      shippingAmount: dto.shippingAmount !== undefined ? dto.shippingAmount : draft.shippingAmount,
      taxAmount: dto.taxAmount !== undefined ? dto.taxAmount : draft.taxAmount,
    };
    const { subtotal, discountAmount, total } = this.recalculate({ items, ...merged });

    const update: Record<string, any> = {
      ...merged, items, subtotal, discountAmount, total,
    };
    if (dto.customerId !== undefined) update.customerId = dto.customerId;
    if (dto.customerName !== undefined) update.customerName = dto.customerName;
    if (dto.customerEmail !== undefined) update.customerEmail = dto.customerEmail;
    if (dto.customerPhone !== undefined) update.customerPhone = dto.customerPhone;
    if (dto.notes !== undefined) update.notes = dto.notes;
    if (dto.shippingAddress !== undefined) update.shippingAddress = dto.shippingAddress;
    if (dto.paymentTerms !== undefined) {
      update.paymentTerms = dto.paymentTerms;
      update.dueDate = computeDueDate(dto.paymentTerms, new Date());
      // Re-arm the overdue check against the new due date, same convention
      // PurchaseOrdersService uses when a PO's expectedAt is edited.
      update.overdueReminderSentAt = null;
    }

    // Any priced-content change invalidates a previously-sent invoice link —
    // a stale emailed link must never be payable against an outdated total.
    // Re-sending (DraftOrdersService.sendInvoice) generates a fresh token.
    const pricedContentChanged = total !== draft.total || JSON.stringify(items) !== JSON.stringify(draft.items);
    if (pricedContentChanged && draft.invoiceToken) {
      update.invoiceToken = null;
      update.invoiceSentAt = null;
    }

    return this.repos.draftOrderModel.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
  }

  async cancel(storeId: string, sellerId: string, id: string) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('Only an open draft order can be cancelled.');
    return this.repos.draftOrderModel.findByIdAndUpdate(id, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { new: true }).lean();
  }

  /** Real "Duplicate" — clones the customer/items/discount/shipping/tax/
   *  notes/shipping-address/payment-terms of an existing draft into a brand
   *  new `open` one. Never copies status/payment/invoice/order-linkage
   *  state — a duplicate is a fresh starting point, not a snapshot of where
   *  the original ended up. */
  async duplicate(storeId: string, sellerId: string, id: string) {
    const source = await this.getOwned(storeId, sellerId, id);
    const draft = await this.repos.draftOrderModel.create({
      storeId,
      sellerId,
      customerId: source.customerId,
      customerName: source.customerName,
      customerEmail: source.customerEmail,
      customerPhone: source.customerPhone,
      items: source.items,
      discountType: source.discountType,
      discountValue: source.discountValue,
      shippingAmount: source.shippingAmount,
      taxAmount: source.taxAmount,
      notes: source.notes,
      currency: source.currency,
      subtotal: source.subtotal,
      discountAmount: source.discountAmount,
      total: source.total,
      status: 'open',
      shippingAddress: source.shippingAddress ?? null,
      paymentTerms: source.paymentTerms ?? null,
      dueDate: computeDueDate(source.paymentTerms, new Date()),
    });

    await this.activityLogService.log({
      storeId, category: 'orders', action: 'draft_order_created',
      description: `Draft order duplicated from ${source.customerName}'s draft`,
      actorId: sellerId, actorRole: 'seller', targetId: draft._id.toString(), targetType: 'draft_order',
    });

    return draft.toObject();
  }

  /** Real hard-delete (via the app's standard `isDelete` soft-delete
   *  convention) — restricted to a draft that was never completed. A
   *  completed draft has a real linked `Order` and must stay discoverable
   *  in history forever, same as every other order-shaped document in this
   *  app; `cancel()` remains the correct action for an open draft the
   *  seller no longer wants to complete but wants to keep a record of. */
  async deleteDraft(storeId: string, sellerId: string, id: string) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status === 'completed') {
      throw new BadRequestException('A completed draft order is linked to a real order and cannot be deleted.');
    }
    await this.repos.draftOrderModel.updateOne({ _id: id }, { $set: { isDelete: true } });
    return { success: true, message: 'Draft order deleted' };
  }

  // ── Send Invoice / public payment link ───────────────────────────────────

  /** Real "Send invoice" — emails the customer a secure link to a public
   *  payment page where they can pay online with a real Stripe charge.
   *  Requires a registered customer account (same hard boundary `complete()`
   *  already enforces — see DraftOrder.customerId's doc comment) and a real
   *  email address, since there's nowhere to send an invoice otherwise. */
  async sendInvoice(storeId: string, sellerId: string, id: string) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('Only an open draft order can be invoiced.');
    if (!draft.customerId) {
      throw new ForbiddenException('Attach a registered customer account to this draft order before sending an invoice.');
    }
    if (!draft.customerEmail) throw new BadRequestException('This customer has no email address to send the invoice to.');
    if (draft.items.length === 0) throw new BadRequestException('This draft order has no items.');

    const store = await this.repos.storeModel.findOne({ _id: storeId, isDelete: false }).lean();
    if (!store) throw new NotFoundException('Store not found');

    const token = randomBytes(24).toString('hex');
    await this.repos.draftOrderModel.updateOne(
      { _id: id },
      { $set: { invoiceToken: token, invoiceSentAt: new Date() } },
    );

    const frontendBase = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const invoiceUrl = `${frontendBase}/pay-invoice/${token}`;

    const symbol = draft.currency === 'PKR' ? 'Rs. ' : draft.currency === 'USD' ? '$' : `${draft.currency} `;
    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2>Invoice from ${(store as any).name}</h2>
        <p>Hi ${draft.customerName},</p>
        <p>You have a new invoice for <strong>${symbol}${draft.total.toFixed(2)}</strong>${draft.paymentTerms === 'due_on_receipt' ? ' due on receipt' : draft.dueDate ? ` due by ${new Date(draft.dueDate).toLocaleDateString()}` : ''}.</p>
        <p><a href="${invoiceUrl}" style="display:inline-block;background:#D97757;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Pay Invoice</a></p>
        <p style="color:#888;font-size:12px;">If the button doesn't work, copy this link: ${invoiceUrl}</p>
      </div>`;
    await this.emailService.sendMail(draft.customerEmail, `Invoice from ${(store as any).name} — ${symbol}${draft.total.toFixed(2)}`, html).catch(() => {});

    await this.activityLogService.log({
      storeId, category: 'orders', action: 'draft_order_invoice_sent',
      description: `Invoice sent to ${draft.customerEmail} for draft order`,
      actorId: sellerId, actorRole: 'seller', targetId: id, targetType: 'draft_order',
    });

    return { success: true, message: 'Invoice sent', data: { invoiceUrl } };
  }

  /** Called once daily by SchedulerService (`runLocked`) — real automated
   *  dunning for an open, invoiced draft order whose `dueDate` has passed
   *  without payment. Re-emails the customer the exact same "Pay Invoice"
   *  link `sendInvoice()` already generates (still valid — only priced-
   *  content changes invalidate it, not the passage of time) framed as
   *  overdue, and separately notifies the seller so they know to follow up.
   *  One reminder per overdue invoice (not a repeating nag) — see
   *  `overdueReminderSentAt`'s doc comment for how it re-arms on a
   *  payment-terms edit. */
  async sendOverdueInvoiceReminders(): Promise<void> {
    const overdue = await this.repos.draftOrderModel
      .find({
        status: 'open',
        isPaid: false,
        invoiceToken: { $ne: null },
        dueDate: { $lt: new Date() },
        overdueReminderSentAt: null,
        isDelete: false,
      })
      .lean();

    for (const draft of overdue) {
      const store = await this.repos.storeModel.findOne({ _id: draft.storeId, isDelete: false }).select('name').lean();
      const storeName = (store as any)?.name ?? 'the store';
      const symbol = draft.currency === 'PKR' ? 'Rs. ' : draft.currency === 'USD' ? '$' : `${draft.currency} `;
      const frontendBase = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
      const invoiceUrl = `${frontendBase}/pay-invoice/${draft.invoiceToken}`;

      if (draft.customerId && draft.customerEmail) {
        const html = `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
            <h2>Overdue invoice from ${storeName}</h2>
            <p>Hi ${draft.customerName},</p>
            <p>Your invoice for <strong>${symbol}${draft.total.toFixed(2)}</strong> was due by ${new Date(draft.dueDate!).toLocaleDateString()} and is still unpaid.</p>
            <p><a href="${invoiceUrl}" style="display:inline-block;background:#D97757;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Pay Invoice</a></p>
            <p style="color:#888;font-size:12px;">If the button doesn't work, copy this link: ${invoiceUrl}</p>
          </div>`;
        await this.notificationsService.notify({
          recipientId: draft.customerId, recipientRole: 'user', storeId: draft.storeId,
          type: NOTIFICATION_TYPES.DRAFT_ORDER_INVOICE_OVERDUE,
          title: 'Overdue invoice',
          body: `Your invoice from ${storeName} for ${symbol}${draft.total.toFixed(2)} is overdue.`,
          data: { draftOrderId: draft._id.toString() },
          email: { subject: `Overdue invoice from ${storeName} — ${symbol}${draft.total.toFixed(2)}`, html },
        });
      }

      await this.notificationsService.notify({
        recipientId: draft.sellerId, recipientRole: 'seller', storeId: draft.storeId,
        type: NOTIFICATION_TYPES.DRAFT_ORDER_INVOICE_OVERDUE,
        title: 'Customer invoice overdue',
        body: `${draft.customerName}'s invoice for ${symbol}${draft.total.toFixed(2)} was due ${new Date(draft.dueDate!).toLocaleDateString()} and is still unpaid.`,
        data: { draftOrderId: draft._id.toString(), link: `/store/${draft.storeId}/draft-orders/${draft._id.toString()}` },
      });

      await this.repos.draftOrderModel.updateOne({ _id: draft._id }, { $set: { overdueReminderSentAt: new Date() } });
    }
  }

  /** Public, unauthenticated — resolves an invoice token to a sanitized
   *  summary for the payment page. Never exposes internal ids beyond what
   *  the page itself needs. */
  async getPublicInvoice(token: string) {
    const draft = await this.repos.draftOrderModel.findOne({ invoiceToken: token, isDelete: false }).lean();
    if (!draft) throw new NotFoundException('Invoice not found or the link has expired');
    if (draft.status !== 'open') throw new BadRequestException('This invoice is no longer open for payment.');

    const store = await this.repos.storeModel.findOne({ _id: draft.storeId, isDelete: false }).select('name logo').lean();

    return {
      customerName: draft.customerName,
      storeName: (store as any)?.name ?? 'Store',
      storeLogo: (store as any)?.logo ?? null,
      items: draft.items.map((i: any) => ({ name: i.name, image: i.image, quantity: i.quantity, unitPrice: i.unitPrice })),
      subtotal: draft.subtotal,
      discountAmount: draft.discountAmount,
      shippingAmount: draft.shippingAmount,
      taxAmount: draft.taxAmount,
      total: draft.total,
      currency: draft.currency,
      isPaid: draft.isPaid,
      dueDate: draft.dueDate,
    };
  }

  /** Public, unauthenticated — creates a real Stripe PaymentIntent for the
   *  invoiced amount. Routes directly to the seller's own connected Stripe
   *  account when eligible — same real single-source-of-truth eligibility
   *  check (`StripeConnectService.getEligibleConnectAccountForStore` +
   *  `CommissionRulesService.resolveRate`) `PaymentService.initiatePayment`
   *  already uses for normal checkout, so a Connect-routed seller pays the
   *  identical effective commission rate either way. A draft order is
   *  always single-store, so the "only if single-store" gate that function
   *  needs doesn't apply here — every invoice is eligible to route through
   *  Connect if the seller has one. Falls back to the platform's shared
   *  account when the seller has no active Connect account, unchanged. The
   *  routing decision is recorded on the PaymentIntent's own `metadata` (no
   *  new DraftOrder schema field needed) so `finalizeInvoicePayment` can
   *  read it straight back off the webhook payload and stamp the resulting
   *  `SellerOrder.settledViaConnect`/`stripeConnectedAccountId` correctly —
   *  the same fields `OrdersService.recordSale`'s ledger-double-credit gate
   *  already checks for every other order. */
  async createInvoicePaymentIntent(token: string) {
    const draft = await this.repos.draftOrderModel.findOne({ invoiceToken: token, isDelete: false });
    if (!draft) throw new NotFoundException('Invoice not found or the link has expired');
    if (draft.status !== 'open') throw new BadRequestException('This invoice is no longer open for payment.');
    if (draft.isPaid) throw new BadRequestException('This invoice has already been paid.');

    const stripe = this.assertStripeConfigured();
    const amountCents = Math.round(draft.total * 100);
    if (amountCents < 50) throw new BadRequestException('Amount is too small to process');

    const connectAccountId = await this.stripeConnectService.getEligibleConnectAccountForStore(draft.storeId);
    let applicationFeeAmountCents = 0;
    if (connectAccountId) {
      const { rate } = await this.commissionRulesService.resolveRate(draft.storeId);
      applicationFeeAmountCents = Math.round(amountCents * rate);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: draft.currency.toLowerCase(),
      metadata: {
        purpose: 'draft_order_invoice',
        draftOrderId: draft._id.toString(),
        invoiceToken: token,
        settledViaConnect: connectAccountId ? 'true' : 'false',
        connectedAccountId: connectAccountId ?? '',
      },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      ...(connectAccountId
        ? { transfer_data: { destination: connectAccountId }, application_fee_amount: applicationFeeAmountCents }
        : {}),
    });

    return { clientSecret: paymentIntent.client_secret, amount: draft.total, currency: draft.currency };
  }

  /** Called from PaymentService.stripeWebhook's `payment_intent.succeeded`
   *  dispatch (metadata.purpose === 'draft_order_invoice') — marks the
   *  invoice paid and auto-completes the draft into a real Order (safe to
   *  do unconditionally here since `sendInvoice()` already hard-requires a
   *  registered `customerId` before an invoice can even be sent). */
  async finalizeInvoicePayment(paymentIntent: { id: string; metadata: Record<string, string> }) {
    const draftOrderId = paymentIntent.metadata?.draftOrderId;
    if (!draftOrderId) return;

    const draft = await this.repos.draftOrderModel.findOne({ _id: draftOrderId, isDelete: false });
    if (!draft || draft.isPaid || draft.status !== 'open') return; // already processed or no longer eligible

    await this.repos.draftOrderModel.updateOne(
      { _id: draftOrderId },
      { $set: { isPaid: true, paidAt: new Date(), invoicePaidAt: new Date() } },
    );

    const connectInfo = {
      settledViaConnect: paymentIntent.metadata?.settledViaConnect === 'true',
      connectedAccountId: paymentIntent.metadata?.connectedAccountId || null,
    };
    await this.complete(draft.storeId, draft.sellerId, draftOrderId, connectInfo);

    await this.activityLogService.log({
      storeId: draft.storeId, category: 'orders', action: 'draft_order_invoice_paid',
      description: `Customer paid invoice online — draft order converted to a real order`,
      actorId: draft.customerId ?? 'customer', actorRole: 'user', targetId: draftOrderId, targetType: 'draft_order',
    });
  }

  /** Real, independent "payment collected" action — records that the
   *  seller has actually collected payment (cash/bank transfer/etc.) for
   *  this open draft, WITHOUT converting it into an Order. Previously this
   *  state didn't exist at all: `complete()` force-marked every resulting
   *  Order as paid regardless of whether money had actually changed hands.
   *  A draft can still be completed while unpaid (see `complete()`) — this
   *  is what lets the seller record payment as its own real step first. */
  async markAsPaid(storeId: string, sellerId: string, id: string) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('Only an open draft order can be marked as paid.');
    if (draft.isPaid) throw new BadRequestException('This draft order is already marked as paid.');
    return this.repos.draftOrderModel.findByIdAndUpdate(id, { $set: { isPaid: true, paidAt: new Date() } }, { new: true }).lean();
  }

  async searchCustomers(storeId: string, sellerId: string, q: string) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    if (!q?.trim()) return [];
    const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await this.repos.userModel
      .find({ $or: [{ name: re }, { email: re }, { phone: re }] })
      .select('name email phone')
      .limit(10)
      .lean();
    return users.map((u: any) => ({ id: u._id.toString(), name: u.name, email: u.email, phone: u.phone }));
  }

  /** Converts an `open` draft with a registered customer attached into a
   *  real `Order` + `SellerOrder` — real stock decrement (same atomic
   *  guarded pattern PaymentService uses for a normal checkout), real
   *  purchaseCount increment, real ActivityLog entry. Deliberately does NOT
   *  run through the buyer checkout pipeline (coupons/campaigns/FX
   *  conversion/shipping-zone resolution) — a merchant-created order is
   *  manually priced by the seller, exactly like Shopify's own Draft
   *  Orders; forcing it through that pipeline would mean re-deriving prices
   *  the seller explicitly set on purpose. */
  async complete(
    storeId: string,
    sellerId: string,
    id: string,
    connectInfo?: { settledViaConnect: boolean; connectedAccountId: string | null },
  ) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('This draft order was already completed or cancelled.');
    if (!draft.customerId) {
      throw new ForbiddenException('Attach a registered customer account to this draft order before completing it.');
    }
    if (draft.items.length === 0) throw new BadRequestException('This draft order has no items.');

    const physicalItems = draft.items.filter((i: any) => i.type === 'physical');
    const digitalItems = draft.items.filter((i: any) => i.type !== 'physical');

    // Atomic stock decrement, physical items only — a Draft Order is
    // completed (fulfilled) instantly, same as a POS sale, so this decrements
    // real `stock` directly rather than reserving via `committedStock` (that
    // model is only for checkout's pending-until-shipped online orders — see
    // ProductVariant.committedStock's doc comment). Guarded against real
    // availability (`stock - committedStock`) so a Draft Order can't oversell
    // stock already reserved by a pending online order.
    const decremented: { variantId: string; quantity: number }[] = [];
    for (const item of physicalItems) {
      const variant = await this.repos.productVariantModel.findOne({ _id: item.variantId, isDelete: false }).select('unlimitedStock').lean();
      if (!variant || (variant as any).unlimitedStock) continue;
      const res = await this.repos.productVariantModel.updateOne(
        {
          _id: item.variantId,
          isDelete: false,
          $expr: { $gte: [{ $subtract: ['$stock', '$committedStock'] }, item.quantity] },
        },
        { $inc: { stock: -item.quantity } },
      );
      if (res.modifiedCount === 0) {
        for (const d of decremented) {
          await this.repos.productVariantModel.updateOne({ _id: d.variantId }, { $inc: { stock: d.quantity } });
        }
        throw new BadRequestException(`Stock not available for item: ${item.name}`);
      }
      decremented.push({ variantId: item.variantId, quantity: item.quantity });
    }

    const toOrderItem = (i: any) => ({
      productId: i.productId, variantId: i.variantId, type: i.type, productType: i.type,
      name: i.name, image: i.image, sku: i.sku, options: i.options, licenseType: null,
      quantity: i.quantity, price: i.unitPrice, totalPrice: round(i.unitPrice * i.quantity),
      status: 'pending',
    });

    const sellerOrder = {
      sellerId,
      storeId,
      fulfillmentType: physicalItems.length > 0 && digitalItems.length > 0 ? 'mixed' : physicalItems.length > 0 ? 'physical' : 'digital',
      items: draft.items.map(toOrderItem),
      subtotal: draft.subtotal,
      status: 'pending',
      // Set only when this completion is the direct result of a real online
      // Stripe invoice payment (see finalizeInvoicePayment) — lets
      // OrdersService.recordSale's ledger-credit guard skip this sellerOrder
      // exactly like it already does for a normal Connect-routed checkout,
      // since the money already landed directly in the seller's own account.
      settledViaConnect: connectInfo?.settledViaConnect ?? false,
      stripeConnectedAccountId: connectInfo?.connectedAccountId ?? null,
    };

    // The resulting Order's payment state is derived from whether the
    // seller actually recorded payment — never force-set to 'paid'
    // regardless of reality. A real online Stripe invoice payment
    // (connectInfo present) is a genuine card payment, not a manual
    // bank-transfer confirmation, so it's recorded as such; an unpaid draft
    // can still be completed (fulfilled now, paid later, e.g.
    // invoice-on-delivery) — 'pending_verification' is the same real
    // convention the manual-bank-transfer checkout path already uses for
    // "awaiting confirmation."
    const paymentInfo = connectInfo
      ? { paymentType: 'stripe', paymentStatus: 'paid', isPaid: true, paidAt: draft.paidAt ?? new Date() }
      : draft.isPaid
        ? { paymentType: 'manual_bank_transfer', paymentStatus: 'paid', isPaid: true, paidAt: draft.paidAt ?? new Date() }
        : { paymentType: 'manual_bank_transfer', paymentStatus: 'pending_verification', isPaid: false, paidAt: null };

    // Phase 0 — currency normalization: this order-creation path previously
    // always persisted `fxSnapshots: []` (no real Checkout backs a draft
    // order, so nothing ever populated it) — making every draft-converted
    // order in a non-USD currency permanently unconvertible to USD for
    // analytics (see Order.ratePerUSD). This IS a real "right now" event
    // (the draft is being converted to a real Order this instant, not a
    // historical backfill), so fetching a current snapshot here — the same
    // thing CheckoutService does at real checkout time — is legitimate, not
    // a guess. `buildSnapshots` short-circuits to `ratePerUSD: 1` for USD.
    const draftFxSnapshots = await this.exchangeRateService.buildSnapshots([draft.currency]);
    const draftRatePerUSD = draft.currency === 'USD'
      ? 1
      : (draftFxSnapshots.find((s: any) => s.currency === draft.currency)?.ratePerUSD ?? null);

    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const order = await this.repos.orderModel.create({
      orderNumber,
      userId: draft.customerId,
      // No real Checkout doc backs a manually-created draft order — this is
      // a stable, clearly-prefixed reference back to the draft it came from,
      // never confused with a real Checkout ObjectId.
      checkoutId: `draft-${draft._id.toString()}`,
      currency: draft.currency,
      fxSnapshots: draftFxSnapshots,
      ratePerUSD: draftRatePerUSD,
      sellerOrders: [sellerOrder],
      shippingAddress: draft.shippingAddress ?? null,
      subtotal: draft.subtotal,
      shippingFee: draft.shippingAmount,
      taxAmount: draft.taxAmount,
      couponDiscountTotal: draft.discountAmount,
      totalAmount: draft.total,
      paymentTerms: draft.paymentTerms ?? null,
      dueDate: draft.dueDate ?? null,
      ...paymentInfo,
      orderStatus: 'processing',
    });

    for (const item of draft.items) {
      await this.repos.productModel.updateOne({ _id: item.productId }, { $inc: { purchaseCount: item.quantity } });
    }

    await this.repos.draftOrderModel.updateOne(
      { _id: id },
      { $set: { status: 'completed', orderId: order._id.toString(), orderNumber, completedAt: new Date() } },
    );

    await this.activityLogService.log({
      storeId, category: 'orders', action: 'draft_order_completed',
      description: `Draft order converted to order #${orderNumber}`,
      actorId: sellerId, actorRole: 'seller', targetId: order._id.toString(), targetType: 'order',
    });

    return { draftOrderId: id, orderId: order._id.toString(), orderNumber };
  }
}
