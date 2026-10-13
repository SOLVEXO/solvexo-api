/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { InventoryService } from '../inventory/inventory.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { AVAILABLE_STOCK_EXPR } from '../common/stock-availability.util';
import { drainLocationStock } from '../common/location-stock.util';
import { consumeLots } from '../common/lot-consumption.util';
import { refreshExpiredStock } from '../common/expired-stock.util';
import { SUPPLIER_RETURN_REASONS } from './schemas/supplier-return.schema';
import { toCsv } from '../analytics/utils/csv.util';

const round = (n: number) => Math.round(n * 100) / 100;

export class SupplierReturnLineDto {
  @IsString() variantId: string;
  @IsInt() @Min(1) quantity: number;
  /** optional override; defaults to the lot's / PO line's / variant's cost */
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;
  @IsOptional() @IsString() lotId?: string;
  /** take the units from the damaged (unsellable) pool instead of sellable stock */
  @IsOptional() @IsBoolean() fromDamaged?: boolean;
  @IsOptional() @IsString() purchaseOrderItemId?: string;
}

export class CreateSupplierReturnDto {
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() supplierName?: string;
  @IsOptional() @IsString() purchaseOrderId?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsIn([...SUPPLIER_RETURN_REASONS]) reason?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** client-generated per submit: a double click / retry returns the original instead of removing stock twice */
  @IsOptional() @IsString() @MaxLength(100) requestId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SupplierReturnLineDto)
  items: SupplierReturnLineDto[];
}

@Injectable()
export class SupplierReturnsService implements OnModuleInit {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly inventoryService: InventoryService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  onModuleInit() {
    // a queued staff return is applied through the normal create() path when a manager approves it in the approvals queue
    this.inventoryService.registerApprovalHandler('supplier_return', async (p, reviewer) => {
      const res: any = await this.create(p.storeId, p.sellerId, p.dto, reviewer.reviewerId, undefined);
      return res.data;
    });
  }

  /** A return removes sellable stock, so a staff member needs more than purchase_orders.manage: inventory.adjust, and
   *  inventory.approve for a large (>= the store's staff approval threshold, default 20 units) or damaged-pool line —
   *  the same bar a manual stock reduction already has. Owners/admins are never restricted. */
  private async staffNeedsApproval(storeId: string, dto: CreateSupplierReturnDto, actor?: { role?: string; permissions?: string[] | null }): Promise<{ needs: boolean; threshold: number }> {
    if (actor?.role !== 'staff') return { needs: false, threshold: 0 };
    const perms = actor.permissions ?? [];
    if (!perms.includes('inventory.adjust')) throw new ForbiddenException('Returning stock to a supplier needs the "adjust inventory" permission.');
    if (perms.includes('inventory.approve')) return { needs: false, threshold: 0 };
    const store: any = await this.r.storeModel.findOne({ _id: storeId }).select('staffApprovalThreshold').lean();
    const threshold = store?.staffApprovalThreshold ?? 20;
    return { needs: dto.items.some((l) => l.fromDamaged || l.quantity >= threshold), threshold };
  }

  async create(storeId: string, sellerId: string, dto: CreateSupplierReturnDto, actorId?: string, actor?: { role?: string; permissions?: string[] | null }) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    // A staff member below the approval bar (large or damaged-pool return, no inventory.approve) does not move stock: the request
    // is queued in the same approvals queue manual adjustments use, and applied verbatim when a manager approves it.
    const gate = await this.staffNeedsApproval(storeId, dto, actor);
    if (gate.needs) {
      const staff: any = await this.r.staffMemberModel.findById(actorId).select('name').lean().catch(() => null);
      const units = dto.items.reduce((s, l) => s + l.quantity, 0);
      const approval = await this.r.approvalRequestModel.create({
        storeId, type: 'supplier_return',
        payload: { storeId, sellerId, dto },
        summary: `Supplier return — ${units} unit(s) across ${dto.items.length} line(s)${dto.supplierName ? ' to ' + dto.supplierName : ''} (${dto.reason ?? 'other'})`,
        requestedBy: actorId ?? sellerId, requestedByName: staff?.name ?? null, status: 'pending',
      });
      return { success: true, pendingApproval: true, duplicate: false, data: approval.toObject() };
    }
    const { supplierReturnModel, supplierModel, purchaseOrderModel, productVariantModel, productModel, variantLocationStockModel, storeLocationModel } = this.r;

    if (dto.requestId) {
      const existing = await supplierReturnModel.findOne({ storeId, requestId: dto.requestId }).lean();
      if (existing) return { success: true, duplicate: true, data: existing };
    }
    const seen = new Set<string>();
    for (const l of dto.items) {
      const k = `${l.variantId}|${l.lotId ?? ''}|${l.fromDamaged ? 'd' : 's'}`;
      if (seen.has(k)) throw new BadRequestException('The same product/lot appears twice — combine the quantities into one line');
      seen.add(k);
    }

    let supplierId: string | null = null;
    let supplierName = dto.supplierName?.trim() || '';
    if (dto.supplierId) {
      const sup: any = await supplierModel.findOne({ _id: dto.supplierId, storeId, isDelete: false }).lean();
      if (!sup) throw new NotFoundException('Supplier not found');
      supplierId = String(sup._id); supplierName = sup.name;
    }
    let poId: string | null = null;
    if (dto.purchaseOrderId) {
      const po: any = await purchaseOrderModel.findOne({ _id: dto.purchaseOrderId, storeId }).lean();
      if (!po) throw new NotFoundException('Purchase order not found');
      poId = String(po._id);
      supplierId = supplierId ?? po.supplierId ?? null;
      supplierName = supplierName || po.supplierName;
    }
    if (!supplierName) throw new BadRequestException('Choose a supplier (or enter a supplier name)');

    if (dto.locationId) {
      const loc = await storeLocationModel.findOne({ _id: dto.locationId, storeId, isDelete: false }).lean();
      if (!loc) throw new NotFoundException('Location not found');
    }
    // location rows must exist before a location-specific return can take units from them (idempotent, outside the tx)
    if (dto.locationId) {
      for (const l of dto.items) {
        const v: any = await productVariantModel.findOne({ _id: l.variantId, storeId, isDelete: false });
        if (v) await this.inventoryService.ensureLocationStockSeeded(storeId, l.variantId, v);
      }
    }

    const returnNumber = `SR-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const reason = (dto.reason as any) ?? 'other';

    let created: any;
    try {
      created = await this.connection.transaction(async (session) => {
        const items: any[] = [];
        let totalCredit = 0;
        const po: any = poId ? await purchaseOrderModel.findOne({ _id: poId, storeId }).session(session) : null;

        for (const line of dto.items) {
          const variant: any = await productVariantModel.findOne({ _id: line.variantId, storeId, isDelete: false }).session(session);
          if (!variant) throw new NotFoundException('A product in this return no longer exists in your store');
          if (variant.unlimitedStock) throw new BadRequestException(`"${line.variantId}" has unlimited stock — nothing to return`);
          const product: any = await productModel.findOne({ _id: variant.productId, storeId, isDelete: false }).select('name').session(session).lean();
          const name = product?.name ?? 'Product';
          const qty = line.quantity;

          // PO line: a return can never exceed what was received on that line, minus what was already returned
          let poItem: any = null;
          if (po) {
            poItem = line.purchaseOrderItemId ? po.items.id(line.purchaseOrderItemId) : po.items.find((i: any) => i.variantId === line.variantId);
            if (!poItem || poItem.variantId !== line.variantId) throw new BadRequestException(`${name} is not on that purchase order`);
            const returnable = (poItem.quantityReceived ?? 0) - (poItem.quantityReturned ?? 0);
            if (qty > returnable) throw new BadRequestException(`${name}: only ${Math.max(0, returnable)} unit(s) can still be returned against ${po.poNumber}`);
          }

          // 1) variant total, with the floor enforced inside the filter
          const filter: any = { _id: variant._id, isDelete: false };
          const inc: any = { stock: -qty };
          if (line.fromDamaged) {
            filter.damagedStock = { $gte: qty };
            filter.$expr = { $gte: [{ $subtract: ['$stock', qty] }, { $ifNull: ['$committedStock', 0] }] };
            inc.damagedStock = -qty;
          } else {
            filter.$expr = { $gte: [AVAILABLE_STOCK_EXPR, qty] };
          }
          const before = await productVariantModel.findOneAndUpdate(filter, { $inc: inc }, { new: false, session });
          if (!before) {
            throw new BadRequestException(line.fromDamaged
              ? `${name}: fewer than ${qty} damaged unit(s) on record, or the rest is reserved by open orders`
              : `${name}: only part of that quantity is sellable right now (reserved/damaged units can't be returned as sellable stock)`);
          }

          // 2) location row(s)
          if (dto.locationId) {
            const row = await variantLocationStockModel.findOneAndUpdate(
              { variantId: String(variant._id), locationId: dto.locationId, stock: { $gte: qty } },
              { $inc: { stock: -qty } },
              { session },
            );
            if (!row) throw new BadRequestException(`${name}: not enough stock at the chosen location`);
          } else {
            await drainLocationStock(this.r, String(variant._id), qty, { session });
          }

          // 3) lots (cost source) — a named lot, or FEFO for a lot-tracked variant
          let unitCost: number | null = line.unitCost ?? null;
          if (line.lotId) {
            const lot: any = await this.r.stockLotModel.findOneAndUpdate(
              { _id: line.lotId, variantId: String(variant._id), storeId, status: 'active', quantityRemaining: { $gte: qty } },
              { $inc: { quantityRemaining: -qty } },
              { new: true, session },
            );
            if (!lot) throw new BadRequestException(`${name}: that lot has fewer than ${qty} unit(s) left`);
            if (lot.quantityRemaining <= 0) await this.r.stockLotModel.updateOne({ _id: lot._id }, { $set: { status: 'depleted' } }, { session });
            await refreshExpiredStock(this.r, String(variant._id), { session });
            if (unitCost == null) unitCost = lot.costPrice;
          } else if (variant.trackLots) {
            const cost = await consumeLots(this.r, String(variant._id), qty, { session });
            if (unitCost == null && cost != null) unitCost = round(cost / qty);
          }
          const finalCost: number = unitCost ?? poItem?.unitCost ?? variant.costPrice ?? 0;

          // 4) average cost: remove these units at the cost the supplier credits, so the remaining units keep their true value
          const newStock = (before.stock ?? 0) - qty;
          if (variant.costPrice != null && newStock > 0) {
            const newAvg = ((before.stock ?? 0) * variant.costPrice - qty * finalCost) / newStock;
            if (Number.isFinite(newAvg) && newAvg >= 0) await productVariantModel.updateOne({ _id: variant._id }, { $set: { costPrice: round(newAvg) } }, { session });
          }

          if (poItem) await purchaseOrderModel.updateOne({ _id: poId, 'items._id': poItem._id }, { $inc: { 'items.$.quantityReturned': qty } }, { session });
          if (poItem) poItem.quantityReturned = (poItem.quantityReturned ?? 0) + qty;

          await (this.r.stockAdjustmentModel as any).create([{
            storeId, productId: variant.productId, variantId: String(variant._id), locationId: dto.locationId ?? null,
            productName: name, sku: variant.sku ?? null,
            previousStock: before.stock ?? 0, newStock, delta: -qty, reason: 'supplier_return',
            note: `Returned to ${supplierName} (${returnNumber})${dto.note ? ' — ' + dto.note.trim() : ''}`,
            adjustedBy: actorId ?? sellerId, adjustedByName: null,
          }], { session });

          totalCredit += qty * finalCost;
          items.push({
            productId: variant.productId, variantId: String(variant._id), name, sku: variant.sku ?? null,
            quantity: qty, unitCost: round(finalCost), lotId: line.lotId ?? null, fromDamaged: !!line.fromDamaged, purchaseOrderItemId: poItem ? String(poItem._id) : null,
          });
        }

        const [doc] = await (supplierReturnModel as any).create([{
          storeId, sellerId, returnNumber, supplierId, supplierName, purchaseOrderId: poId, locationId: dto.locationId ?? null,
          reason, note: dto.note?.trim() || null, items, totalCredit: round(totalCredit), requestId: dto.requestId ?? null, createdBy: actorId ?? sellerId,
        }], { session });
        return doc;
      });
    } catch (err: any) {
      // a concurrent submit with the same requestId lost the unique-index race: hand back the winner
      if (err?.code === 11000 && dto.requestId) {
        const existing = await supplierReturnModel.findOne({ storeId, requestId: dto.requestId }).lean();
        if (existing) return { success: true, duplicate: true, data: existing };
      }
      throw err;
    }

    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'supplier_return_created',
      description: `Supplier return ${created.returnNumber} to ${supplierName} — ${created.items.length} line(s), credit ${created.totalCredit}`,
      actorId: actorId ?? sellerId, actorRole: 'seller', targetId: String(created._id), targetType: 'supplier_return',
    });
    return { success: true, duplicate: false, data: created.toObject() };
  }

  async list(storeId: string, sellerId: string, query: { page?: string; limit?: string; creditStatus?: string } = {}) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '20', 10) || 20));
    const filter: any = { storeId };
    if (query.creditStatus === 'pending' || query.creditStatus === 'received') filter.creditStatus = query.creditStatus;
    const [rows, total] = await Promise.all([
      this.r.supplierReturnModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.supplierReturnModel.countDocuments(filter),
    ]);
    return { success: true, data: rows, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** CSV of every supplier return (one row per returned line), newest first, max 20000 lines. */
  async exportCsv(storeId: string, sellerId: string): Promise<string> {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const docs: any[] = await this.r.supplierReturnModel.find({ storeId }).sort({ createdAt: -1 }).limit(5000).lean();
    const rows: (string | number)[][] = [];
    for (const d of docs) {
      for (const i of d.items ?? []) {
        rows.push([
          d.returnNumber, d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : '', d.supplierName, d.reason, i.name, i.sku ?? '',
          i.quantity, i.unitCost, Math.round(i.quantity * i.unitCost * 100) / 100, d.creditStatus, d.note ?? '',
        ]);
      }
    }
    return toCsv(['Return', 'Date', 'Supplier', 'Reason', 'Product', 'SKU', 'Quantity', 'Credit per unit', 'Line credit', 'Credit status', 'Note'], rows.slice(0, 20000));
  }

  /** The supplier's credit/refund arrived. Atomic claim: marking twice is a no-op error, never a double count. */
  async markCreditReceived(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
    const done = await this.r.supplierReturnModel.findOneAndUpdate(
      { _id: id, storeId, creditStatus: 'pending' },
      { $set: { creditStatus: 'received', creditReceivedAt: new Date() } },
      { new: true },
    );
    if (!done) {
      const cur = await this.r.supplierReturnModel.findOne({ _id: id, storeId }).select('creditStatus').lean();
      if (!cur) throw new NotFoundException('Supplier return not found');
      throw new BadRequestException('The credit for this return was already marked as received');
    }
    return { success: true, data: done.toObject() };
  }
}
