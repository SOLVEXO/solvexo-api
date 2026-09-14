/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipOrForbidden, verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

function round(n: number) {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly inventoryService: InventoryService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  // ── Suppliers ──────────────────────────────────────────────────────────

  async createSupplier(storeId: string, sellerId: string, dto: CreateSupplierDto) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const supplier = await this.repos.supplierModel.create({
      storeId, sellerId,
      name: dto.name, email: dto.email ?? null, phone: dto.phone ?? null,
      address: dto.address ?? null, notes: dto.notes ?? null,
      status: 'active',
    });
    return supplier.toObject();
  }

  async listSuppliers(storeId: string, sellerId: string) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    return this.repos.supplierModel.find({ storeId, isDelete: false }).sort({ name: 1 }).lean();
  }

  async updateSupplier(storeId: string, sellerId: string, supplierId: string, dto: UpdateSupplierDto) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const supplier = await this.repos.supplierModel.findOne({ _id: supplierId, storeId, isDelete: false });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (dto.name !== undefined) supplier.name = dto.name;
    if (dto.email !== undefined) supplier.email = dto.email ?? null;
    if (dto.phone !== undefined) supplier.phone = dto.phone ?? null;
    if (dto.address !== undefined) supplier.address = dto.address ?? null;
    if (dto.notes !== undefined) supplier.notes = dto.notes ?? null;
    if (dto.status !== undefined) supplier.status = dto.status;
    await supplier.save();
    return supplier.toObject();
  }

  async archiveSupplier(storeId: string, sellerId: string, supplierId: string) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const supplier = await this.repos.supplierModel.findOneAndUpdate(
      { _id: supplierId, storeId, isDelete: false },
      { $set: { status: 'archived' } },
      { new: true },
    );
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier.toObject();
  }

  // ── Purchase Orders ────────────────────────────────────────────────────

  private async resolveItems(storeId: string, items: { productId: string; variantId: string; quantityOrdered: number; unitCost: number }[]) {
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
        name: (product as any).name,
        image: (product as any).images?.[0] ?? null,
        sku: (variant as any).sku ?? null,
        options: (variant as any).options ?? [],
        quantityOrdered: item.quantityOrdered,
        quantityReceived: 0,
        quantityDamaged: 0,
        unitCost: item.unitCost,
      });
    }
    return resolved;
  }

  private recalculate(po: { items: { unitCost: number; quantityOrdered: number }[]; shippingCost: number; taxCost: number }) {
    const subtotal = round(po.items.reduce((s, i) => s + i.unitCost * i.quantityOrdered, 0));
    const total = round(subtotal + (po.shippingCost ?? 0) + (po.taxCost ?? 0));
    return { subtotal, total };
  }

  async create(storeId: string, sellerId: string, dto: CreatePurchaseOrderDto) {
    const store = await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const items = await this.resolveItems(storeId, dto.items);
    const base = { shippingCost: dto.shippingCost ?? 0, taxCost: dto.taxCost ?? 0 };
    const { subtotal, total } = this.recalculate({ items, ...base });

    const poNumber = `PO-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const po = await this.repos.purchaseOrderModel.create({
      storeId, sellerId,
      supplierId: dto.supplierId ?? null,
      supplierName: dto.supplierName,
      locationId: dto.locationId ?? null,
      items, ...base,
      notes: dto.notes ?? '',
      currency: store.baseCurrency ?? 'PKR',
      subtotal, total,
      status: 'draft',
      poNumber,
      expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : null,
      createdBy: sellerId,
    });

    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'purchase_order_created',
      description: `Purchase order ${poNumber} created for ${dto.supplierName}`,
      actorId: sellerId, actorRole: 'seller', targetId: po._id.toString(), targetType: 'purchase_order',
    });

    return po.toObject();
  }

  async list(storeId: string, sellerId: string, query: { status?: string; search?: string; page?: number; limit?: number }) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const filter: Record<string, any> = { storeId };
    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.search?.trim()) {
      const re = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ poNumber: re }, { supplierName: re }];
    }
    const [items, total, statusCounts] = await Promise.all([
      this.repos.purchaseOrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.repos.purchaseOrderModel.countDocuments(filter),
      this.repos.purchaseOrderModel.aggregate([{ $match: { storeId } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);
    const counts: Record<string, number> = {};
    for (const c of statusCounts) counts[c._id] = c.count;
    return { items, total, page, limit, counts };
  }

  private async getOwned(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const po = await this.repos.purchaseOrderModel.findOne({ _id: id, storeId });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async getById(storeId: string, sellerId: string, id: string) {
    const po = await this.getOwned(storeId, sellerId, id);
    return po.toObject();
  }

  async update(storeId: string, sellerId: string, id: string, dto: UpdatePurchaseOrderDto) {
    const po = await this.getOwned(storeId, sellerId, id);
    if (po.status !== 'draft') throw new BadRequestException('Only a draft purchase order can be edited.');

    const items = dto.items ? await this.resolveItems(storeId, dto.items) : po.items;
    const merged = {
      shippingCost: dto.shippingCost !== undefined ? dto.shippingCost : po.shippingCost,
      taxCost: dto.taxCost !== undefined ? dto.taxCost : po.taxCost,
    };
    const { subtotal, total } = this.recalculate({ items: items as any, ...merged });

    if (dto.supplierId !== undefined) po.supplierId = dto.supplierId ?? null;
    if (dto.supplierName !== undefined) po.supplierName = dto.supplierName;
    if (dto.locationId !== undefined) po.locationId = dto.locationId ?? null;
    if (dto.notes !== undefined) po.notes = dto.notes;
    if (dto.expectedAt !== undefined) {
      po.expectedAt = dto.expectedAt ? new Date(dto.expectedAt) : null;
      po.overdueAlertSentAt = null; // re-arm the overdue check against the new date
    }
    po.items = items as any;
    po.shippingCost = merged.shippingCost;
    po.taxCost = merged.taxCost;
    po.subtotal = subtotal;
    po.total = total;
    await po.save();
    return po.toObject();
  }

  async markAsOrdered(storeId: string, sellerId: string, id: string) {
    const po = await this.getOwned(storeId, sellerId, id);
    if (po.status !== 'draft') throw new BadRequestException('Only a draft purchase order can be marked as ordered.');
    po.status = 'ordered';
    po.orderedAt = new Date();
    await po.save();
    return po.toObject();
  }

  async cancel(storeId: string, sellerId: string, id: string) {
    const po = await this.getOwned(storeId, sellerId, id);
    if (po.status !== 'draft' && po.status !== 'ordered') {
      throw new BadRequestException(`Only a draft or ordered purchase order can be cancelled (this one is "${po.status}").`);
    }
    po.status = 'cancelled';
    po.cancelledAt = new Date();
    await po.save();
    return po.toObject();
  }

  /** Explicit action to mark a partially-received PO as done when the
   *  supplier confirms no more is coming — otherwise a short-shipped PO
   *  would stay "partially received" forever with no way to close it out. */
  async closeShort(storeId: string, sellerId: string, id: string) {
    const po = await this.getOwned(storeId, sellerId, id);
    if (po.status !== 'partially_received') {
      throw new BadRequestException(`Only a partially-received purchase order can be closed short (this one is "${po.status}").`);
    }
    po.status = 'closed_short';
    await po.save();
    return po.toObject();
  }

  /** POST .../:poId/receive — the real "goods arrived" step, callable more
   *  than once for a genuine partial/multi-shipment delivery. Good units go
   *  to real sellable `stock` (+ the destination location's row, if the PO
   *  has one); damaged-on-arrival units go to `damagedStock` instead — both
   *  still count as real on-hand `stock` (see ProductVariant.damagedStock's
   *  doc comment), just not sellable. Deliberately allows the total
   *  received to exceed `quantityOrdered` (a real supplier can over-ship) —
   *  logged back as a discrepancy, never rejected outright. Cost is
   *  maintained as a genuine weighted average, not overwritten with the
   *  latest receipt's price. */
  async receive(storeId: string, sellerId: string, id: string, dto: ReceivePurchaseOrderDto) {
    const po = await this.getOwned(storeId, sellerId, id);
    if (po.status !== 'ordered' && po.status !== 'partially_received') {
      throw new BadRequestException(`Cannot receive against a purchase order that is "${po.status}".`);
    }

    const seller = await this.repos.sellerModel.findOne({ _id: sellerId }).select('name');
    const discrepancies: string[] = [];

    for (const line of dto.items) {
      const item = (po.items as any).id(line.itemId);
      if (!item) throw new BadRequestException(`Line item ${line.itemId} not found on this purchase order`);
      const goodQty = line.quantityReceived ?? 0;
      const damagedQty = line.quantityDamaged ?? 0;
      const totalThisReceipt = goodQty + damagedQty;
      if (totalThisReceipt <= 0) continue;

      const variant = await this.repos.productVariantModel.findOne({ _id: item.variantId, isDelete: false });
      if (!variant) {
        discrepancies.push(`${item.name}: its variant no longer exists — skipped`);
        continue;
      }

      const previousStock = variant.stock || 0;
      const previousCost = variant.costPrice;
      const newCost = previousCost == null
        ? item.unitCost
        : (previousStock * previousCost + totalThisReceipt * item.unitCost) / (previousStock + totalThisReceipt);

      if (goodQty > 0 && po.locationId) {
        await this.inventoryService.ensureLocationStockSeeded(storeId, item.variantId, variant);
        await this.repos.variantLocationStockModel.updateOne(
          { variantId: item.variantId, locationId: po.locationId },
          { $inc: { stock: goodQty }, $setOnInsert: { storeId, productId: item.productId } },
          { upsert: true },
        );
      }
      await this.repos.productVariantModel.updateOne(
        { _id: item.variantId },
        { $inc: { stock: totalThisReceipt, damagedStock: damagedQty }, $set: { costPrice: round(newCost) } },
      );

      item.quantityReceived += goodQty;
      item.quantityDamaged += damagedQty;
      const receivedSoFar = item.quantityReceived + item.quantityDamaged;
      if (receivedSoFar > item.quantityOrdered) {
        discrepancies.push(`${item.name}: received ${receivedSoFar} of ${item.quantityOrdered} ordered (over-shipped by ${receivedSoFar - item.quantityOrdered})`);
      }

      if (goodQty > 0) {
        await this.repos.stockAdjustmentModel.create({
          storeId, productId: item.productId, variantId: item.variantId, locationId: po.locationId ?? null,
          productName: item.name, sku: item.sku,
          previousStock, newStock: previousStock + goodQty, delta: goodQty,
          reason: 'purchase_received', note: `PO #${po.poNumber}`,
          adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
        });
      }
      if (damagedQty > 0) {
        discrepancies.push(`${item.name}: ${damagedQty} unit(s) damaged on arrival`);
        await this.repos.stockAdjustmentModel.create({
          storeId, productId: item.productId, variantId: item.variantId, locationId: null,
          productName: item.name, sku: item.sku,
          previousStock: previousStock + goodQty, newStock: previousStock + totalThisReceipt, delta: damagedQty,
          reason: 'damaged', note: `Damaged on arrival — PO #${po.poNumber}`,
          adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
        });
      }
    }

    const fullyReceived = (po.items as any[]).every((i) => (i.quantityReceived + i.quantityDamaged) >= i.quantityOrdered);
    po.status = fullyReceived ? 'received' : 'partially_received';
    if (fullyReceived) po.receivedAt = new Date();
    await po.save();

    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'purchase_order_received',
      description: `Purchase order ${po.poNumber} ${fullyReceived ? 'fully received' : 'partially received'}`,
      actorId: sellerId, actorRole: 'seller', targetId: id, targetType: 'purchase_order',
    });

    return { po: po.toObject(), discrepancies };
  }

  /** Called once daily by SchedulerService (`runLocked`) — flags any PO
   *  whose `expectedAt` has passed but is still awaiting (full) receipt.
   *  One notification per overdue PO (not batched into a digest like the
   *  low-stock alert) since each is its own actionable follow-up with its
   *  own supplier, not an aggregate count. */
  async sendOverdueAlerts(): Promise<void> {
    const overdue = await this.repos.purchaseOrderModel
      .find({ status: { $in: ['ordered', 'partially_received'] }, expectedAt: { $lt: new Date() }, overdueAlertSentAt: null })
      .lean();

    for (const po of overdue) {
      await this.notificationsService.notify({
        recipientId: po.sellerId, recipientRole: 'seller', storeId: po.storeId,
        type: NOTIFICATION_TYPES.PURCHASE_ORDER_OVERDUE,
        title: 'Purchase order overdue',
        body: `${po.poNumber} (${po.supplierName}) was expected by ${new Date(po.expectedAt!).toLocaleDateString()} and hasn't been fully received.`,
        data: { poId: po._id.toString(), link: `/store/${po.storeId}/purchase-orders/${po._id.toString()}` },
      });
      await this.repos.purchaseOrderModel.updateOne({ _id: po._id }, { $set: { overdueAlertSentAt: new Date() } });
    }
  }
}
