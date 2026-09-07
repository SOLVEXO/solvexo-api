/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateDraftOrderDto } from './dto/create-draft-order.dto';
import { UpdateDraftOrderDto } from './dto/update-draft-order.dto';

function round(n: number) {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class DraftOrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
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
    const filter: Record<string, any> = { storeId };
    if (query.status) filter.status = query.status;
    const [items, total] = await Promise.all([
      this.repos.draftOrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.repos.draftOrderModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }

  private async getOwned(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const draft = await this.repos.draftOrderModel.findOne({ _id: id, storeId }).lean();
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

    return this.repos.draftOrderModel.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
  }

  async cancel(storeId: string, sellerId: string, id: string) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('Only an open draft order can be cancelled.');
    return this.repos.draftOrderModel.findByIdAndUpdate(id, { $set: { status: 'cancelled', cancelledAt: new Date() } }, { new: true }).lean();
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
  async complete(storeId: string, sellerId: string, id: string) {
    const draft = await this.getOwned(storeId, sellerId, id);
    if (draft.status !== 'open') throw new BadRequestException('This draft order was already completed or cancelled.');
    if (!draft.customerId) {
      throw new ForbiddenException('Attach a registered customer account to this draft order before completing it.');
    }
    if (draft.items.length === 0) throw new BadRequestException('This draft order has no items.');

    const physicalItems = draft.items.filter((i: any) => i.type === 'physical');
    const digitalItems = draft.items.filter((i: any) => i.type !== 'physical');

    // Atomic stock decrement, physical items only — identical guard pattern
    // to PaymentService.createOrder's checkout-time decrement.
    const decremented: { variantId: string; quantity: number }[] = [];
    for (const item of physicalItems) {
      const variant = await this.repos.productVariantModel.findOne({ _id: item.variantId, isDelete: false }).select('unlimitedStock').lean();
      if (!variant || (variant as any).unlimitedStock) continue;
      const res = await this.repos.productVariantModel.updateOne(
        { _id: item.variantId, stock: { $gte: item.quantity }, isDelete: false },
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
    };

    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const order = await this.repos.orderModel.create({
      orderNumber,
      userId: draft.customerId,
      // No real Checkout doc backs a manually-created draft order — this is
      // a stable, clearly-prefixed reference back to the draft it came from,
      // never confused with a real Checkout ObjectId.
      checkoutId: `draft-${draft._id.toString()}`,
      currency: draft.currency,
      fxSnapshots: [],
      sellerOrders: [sellerOrder],
      shippingAddress: null,
      subtotal: draft.subtotal,
      shippingFee: draft.shippingAmount,
      taxAmount: draft.taxAmount,
      couponDiscountTotal: draft.discountAmount,
      totalAmount: draft.total,
      paymentType: 'manual_bank_transfer',
      paymentStatus: 'paid',
      isPaid: true,
      paidAt: new Date(),
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
