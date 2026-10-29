/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ConflictException, NotFoundException, BadGatewayException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { refreshExpiredStock } from '../common/expired-stock.util';
import { ClientSession, Connection } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../otp/services/email.service';
import { OrderDocumentsService } from '../order-documents/order-documents.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipOrForbidden, verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { importSuppliersCsv } from './supplier-bulk-import';
import { buildPurchaseOrderPdf, type PoPdfBrand, type PoPdfData } from './po-pdf.util';
import { buildPurchaseOrderEmailHtml } from './po-email.util';

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
    private readonly emailService: EmailService,
    private readonly orderDocumentsService: OrderDocumentsService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  // ── Suppliers ──────────────────────────────────────────────────────────

  async createSupplier(storeId: string, sellerId: string, dto: CreateSupplierDto) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    const taken = await this.repos.supplierModel.findOne({ storeId, isDelete: false, name: new RegExp(`^${dto.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean();
    if (taken) throw new ConflictException('A supplier with this name already exists');
    const supplier = await this.repos.supplierModel.create({
      storeId, sellerId,
      name: dto.name, email: dto.email ?? null, phone: dto.phone ?? null,
      address: dto.address ?? null, notes: dto.notes ?? null,
      status: 'active',
    });
    return supplier.toObject();
  }

  /** CSV bulk import — rows go through createSupplier (ownership check,
   *  same fields); a name/email already used in this store is skipped. */
  async importSuppliers(storeId: string, sellerId: string, text: string) {
    await verifyStoreOwnershipOrForbidden(this.repos.storeModel, storeId, sellerId);
    return importSuppliersCsv(
      {
        listExisting: () => this.repos.supplierModel.find({ storeId: String(storeId), isDelete: false }).select('name email').lean() as any,
        create: (dto) => this.createSupplier(storeId, sellerId, dto),
      },
      text,
    );
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
    const supplierEmail = await this.supplierEmailOf(po);
    return { ...po.toObject(), supplierEmail };
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

  /** `emailSupplier` sends the freshly-ordered PO to the supplier's own email
   *  address in the same action. The status change is committed first and
   *  never rolled back by a failed send — a mail problem must not leave the
   *  seller's order stuck in `draft`, so the failure is reported back
   *  (`emailError`) alongside the saved PO instead of throwing. */
  async markAsOrdered(storeId: string, sellerId: string, id: string, emailSupplier = false) {
    const po = await this.getOwned(storeId, sellerId, id);
    if (po.status !== 'draft') throw new BadRequestException('Only a draft purchase order can be marked as ordered.');
    po.status = 'ordered';
    po.orderedAt = new Date();
    await po.save();
    const result: Record<string, unknown> = { ...po.toObject(), emailSent: null as boolean | null, emailError: null as string | null };
    if (emailSupplier) {
      try {
        await this.sendToSupplier(storeId, sellerId, id);
        result.emailSent = true;
      } catch (err) {
        result.emailSent = false;
        result.emailError = err instanceof Error ? err.message : 'The email could not be sent.';
      }
    }
    return result;
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

  // ── Documents: branded PDF + supplier email ────────────────────────────

  private async supplierEmailOf(po: { storeId: string; supplierId?: string | null }) {
    if (!po.supplierId) return null;
    const supplier = await this.repos.supplierModel
      .findOne({ _id: po.supplierId, storeId: po.storeId, isDelete: false }).select('email').lean();
    return (supplier as any)?.email ?? null;
  }

  /** The PO, the store's print branding and the supplier's contact details,
   *  assembled once for both the PDF download and the supplier email. */
  private async buildDocument(storeId: string, sellerId: string, id: string) {
    const po = await this.getOwned(storeId, sellerId, id);
    const { settings, store } = (await this.orderDocumentsService.get(sellerId, storeId)).data;
    const supplier = po.supplierId
      ? ((await this.repos.supplierModel.findOne({ _id: po.supplierId, storeId, isDelete: false }).lean()) as any)
      : null;
    const s = settings as Record<string, any>;
    const taxValue = s.taxIdValue || store.taxId || null;

    const brand: PoPdfBrand = {
      businessName: s.companyName || store.name || 'Store',
      addressText: s.addressText || null,
      phone: s.phone || store.phone || null,
      email: s.email || store.contactEmail || null,
      taxLine: taxValue
        ? `${s.taxIdLabel || (store.country === 'PK' ? 'NTN / STRN' : 'Tax number')}: ${taxValue}`
        : null,
      // Same precedence the printable invoice/slip uses, so a PO and an
      // invoice from one store always look like the same business made them.
      accentColor: typeof s.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.accentColor) ? s.accentColor : '#111111',
      logoUrl: store.logo || null,
      showLogo: s.showLogo !== false,
      showNameWithLogo: s.showNameWithLogo === true,
      logoAlign: ['left', 'center', 'right'].includes(s.logoAlign) ? s.logoAlign : 'left',
    };

    const data: PoPdfData = {
      poNumber: po.poNumber,
      status: po.status,
      // A PO is "issued" when it is ordered; before that it is still a draft
      // the seller is working on, so its creation date is the honest label.
      issuedAt: po.orderedAt ?? po.createdAt ?? new Date(),
      expectedAt: po.expectedAt ?? null,
      orderedAt: po.orderedAt ?? null,
      currency: po.currency,
      supplierName: supplier?.name || po.supplierName,
      supplierEmail: supplier?.email ?? null,
      supplierPhone: supplier?.phone ?? null,
      supplierAddress: supplier?.address ?? null,
      lines: po.items.map(i => ({
        name: i.name,
        options: (i.options ?? []).map(o => o.value),
        sku: i.sku ?? null,
        quantityOrdered: i.quantityOrdered,
        unitCost: i.unitCost,
      })),
      subtotal: po.subtotal,
      shippingCost: po.shippingCost,
      taxCost: po.taxCost,
      total: po.total,
      notes: po.notes?.trim() ? po.notes.trim() : null,
    };

    return { po, brand, data };
  }

  private pdfFilename(poNumber: string) {
    return `${poNumber.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`;
  }

  async buildPdf(storeId: string, sellerId: string, id: string) {
    const { po, brand, data } = await this.buildDocument(storeId, sellerId, id);
    return { buffer: await buildPurchaseOrderPdf(data, brand), filename: this.pdfFilename(po.poNumber) };
  }

  /** Emails the PO to the supplier it was raised against, with the branded PDF attached. */
  async sendToSupplier(storeId: string, sellerId: string, id: string) {
    const { brand, data } = await this.buildDocument(storeId, sellerId, id);
    if (data.status === 'cancelled') throw new BadRequestException('This purchase order was cancelled.');
    if (!data.supplierEmail) {
      throw new BadRequestException('This supplier has no email address yet. Add one under Inventory → Suppliers first.');
    }
    const pdf = await buildPurchaseOrderPdf(data, brand);
    const sent = await this.emailService.sendMail(
      data.supplierEmail,
      `Purchase order ${data.poNumber} from ${brand.businessName}`,
      buildPurchaseOrderEmailHtml(data, brand),
      // A supplier's reply must land in the seller's own inbox, not the platform's shared sender.
      brand.email,
      undefined,
      [{ filename: this.pdfFilename(data.poNumber), content: pdf, contentType: 'application/pdf' }],
      brand.businessName,
    );
    if (!sent) {
      throw new BadGatewayException('The email could not be sent. Try again, or download the PDF and send it yourself.');
    }
    await this.activityLogService.log({
      storeId, category: 'inventory', action: 'purchase_order_emailed',
      description: `Purchase order ${data.poNumber} emailed to ${data.supplierName} (${data.supplierEmail})`,
      actorId: sellerId, actorRole: 'seller', targetId: id, targetType: 'purchase_order',
    });
    return { sent: true, supplierEmail: data.supplierEmail, poNumber: data.poNumber };
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
  /**
   * Receiving is ONE transaction (stock, location rows, lots, serials, audit rows and the PO's own counters commit
   * together or not at all) and the PO document is rewritten inside it, so two concurrent receipts of the same PO
   * conflict and the loser re-reads the new state instead of adding the stock twice. `requestId` (generated by the
   * client per submit) makes a retried/double-clicked submit a harmless no-op that returns the original outcome.
   */
  async receive(storeId: string, sellerId: string, id: string, dto: ReceivePurchaseOrderDto) {
    const preview = await this.getOwned(storeId, sellerId, id);
    const seen = new Set<string>();
    for (const line of dto.items) {
      if (seen.has(line.itemId)) throw new BadRequestException('Each purchase-order line can appear only once per receipt');
      seen.add(line.itemId);
      for (const q of [line.quantityReceived ?? 0, line.quantityDamaged ?? 0]) {
        if (!Number.isInteger(q) || q < 0) throw new BadRequestException('Received and damaged quantities must be whole numbers that are 0 or more');
      }
    }
    // Make sure the receiving location has a stock row for each variant first (idempotent; kept outside the transaction).
    if (preview.locationId) {
      for (const line of dto.items) {
        const it = (preview.items as any).id(line.itemId);
        if (!it || (line.quantityReceived ?? 0) <= 0) continue;
        const v = await this.repos.productVariantModel.findOne({ _id: it.variantId, isDelete: false });
        if (v) await this.inventoryService.ensureLocationStockSeeded(storeId, it.variantId, v as any);
      }
    }
    const seller = await this.repos.sellerModel.findOne({ _id: sellerId }).select('name');
    const outcome = await this.connection.transaction((session) => this.receiveInSession(session, storeId, sellerId, id, dto, seller));

    if (!outcome.duplicate) {
      await this.activityLogService.log({
        storeId, category: 'inventory', action: 'purchase_order_received',
        description: `Purchase order ${outcome.po.poNumber} ${outcome.po.status === 'received' ? 'fully received' : 'partially received'}`,
        actorId: sellerId, actorRole: 'seller', targetId: id, targetType: 'purchase_order',
      });
    }
    return { po: outcome.po, discrepancies: outcome.discrepancies, duplicate: outcome.duplicate };
  }

  private async receiveInSession(session: ClientSession, storeId: string, sellerId: string, id: string, dto: ReceivePurchaseOrderDto, seller: any) {
    const po: any = await this.repos.purchaseOrderModel.findOne({ _id: id, storeId }).session(session);
    if (!po) throw new NotFoundException('Purchase order not found');
    if (dto.requestId && (po.receivedRequestIds ?? []).includes(dto.requestId)) {
      return { po: po.toObject(), discrepancies: [] as string[], duplicate: true };
    }
    if (po.status !== 'ordered' && po.status !== 'partially_received') {
      throw new BadRequestException(`Cannot receive against a purchase order that is "${po.status}".`);
    }

    const discrepancies: string[] = [];

    for (const line of dto.items) {
      const item = (po.items as any).id(line.itemId);
      if (!item) throw new BadRequestException(`Line item ${line.itemId} not found on this purchase order`);
      const goodQty = line.quantityReceived ?? 0;
      const damagedQty = line.quantityDamaged ?? 0;
      const totalThisReceipt = goodQty + damagedQty;
      if (totalThisReceipt <= 0) continue;

      const variant = await this.repos.productVariantModel.findOne({ _id: item.variantId, isDelete: false }).session(session);
      if (!variant) {
        discrepancies.push(`${item.name}: its variant no longer exists — skipped`);
        continue;
      }

      // Serial-tracked variant — one real serial per good unit, required
      // (not best-effort) so a serial-tracked SKU never silently ends up
      // with untracked units mixed into a tracked one. Damaged-on-arrival
      // units still get a serial too (status 'damaged') — they're real,
      // identifiable units, just not sellable.
      if ((variant as any).trackSerials) {
        const serials = (line.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean);
        if (serials.length !== totalThisReceipt) {
          discrepancies.push(`${item.name}: is serial-tracked — expected ${totalThisReceipt} serial number(s), got ${serials.length} — this line was skipped`);
          continue;
        }
        const dupes = await this.repos.stockUnitModel.find({ variantId: item.variantId, serialNumber: { $in: serials } }).select('serialNumber').session(session).lean();
        if (dupes.length > 0) {
          discrepancies.push(`${item.name}: serial number(s) already on record: ${dupes.map((d: any) => d.serialNumber).join(', ')} — this line was skipped`);
          continue;
        }
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
          { upsert: true, session },
        );
      }
      await this.repos.productVariantModel.updateOne(
        { _id: item.variantId },
        { $inc: { stock: totalThisReceipt, damagedStock: damagedQty }, $set: { costPrice: round(newCost) } },
        { session },
      );

      // Real batch/lot ledger row — see StockLot's doc comment. Kept IN
      // ADDITION to the weighted-average `costPrice` update above (never
      // instead of it) — costPrice stays a quick at-a-glance figure, the
      // lot is the real FIFO/FEFO source of truth once opted in. Only the
      // GOOD quantity forms a sellable lot; damaged units never enter it.
      if ((variant as any).trackLots && goodQty > 0) {
        await (this.repos.stockLotModel as any).create([{
          storeId, productId: item.productId, variantId: item.variantId, locationId: po.locationId ?? null,
          lotNumber: line.lotNumber?.trim() || `LOT-${po.poNumber}-${item._id.toString().slice(-4).toUpperCase()}`,
          expiryDate: line.expiryDate ? new Date(line.expiryDate) : null,
          quantityReceived: goodQty, quantityRemaining: goodQty, costPrice: item.unitCost,
          supplierId: po.supplierId ?? null, purchaseOrderId: po._id.toString(),
          status: 'active',
        }], { session });
        if (line.expiryDate) await refreshExpiredStock(this.repos, item.variantId, { session });
      }

      if ((variant as any).trackSerials) {
        const serials = (line.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean);
        const goodSerials = serials.slice(0, goodQty);
        const damagedSerials = serials.slice(goodQty);
        if (goodSerials.length > 0) {
          await this.repos.stockUnitModel.insertMany(goodSerials.map((serialNumber) => ({
            storeId, productId: item.productId, variantId: item.variantId, locationId: po.locationId ?? null,
            serialNumber, status: 'in_stock', purchaseOrderId: po._id.toString(),
          })), { session });
        }
        if (damagedSerials.length > 0) {
          await this.repos.stockUnitModel.insertMany(damagedSerials.map((serialNumber) => ({
            storeId, productId: item.productId, variantId: item.variantId, locationId: null,
            serialNumber, status: 'damaged', purchaseOrderId: po._id.toString(),
          })), { session });
        }
      }

      item.quantityReceived += goodQty;
      item.quantityDamaged += damagedQty;
      const receivedSoFar = item.quantityReceived + item.quantityDamaged;
      if (receivedSoFar > item.quantityOrdered) {
        discrepancies.push(`${item.name}: received ${receivedSoFar} of ${item.quantityOrdered} ordered (over-shipped by ${receivedSoFar - item.quantityOrdered})`);
      }

      if (goodQty > 0) {
        await (this.repos.stockAdjustmentModel as any).create([{
          storeId, productId: item.productId, variantId: item.variantId, locationId: po.locationId ?? null,
          productName: item.name, sku: item.sku,
          previousStock, newStock: previousStock + goodQty, delta: goodQty,
          reason: 'purchase_received', note: `PO #${po.poNumber}`,
          adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
        }], { session });
      }
      if (damagedQty > 0) {
        discrepancies.push(`${item.name}: ${damagedQty} unit(s) damaged on arrival`);
        await (this.repos.stockAdjustmentModel as any).create([{
          storeId, productId: item.productId, variantId: item.variantId, locationId: null,
          productName: item.name, sku: item.sku,
          previousStock: previousStock + goodQty, newStock: previousStock + totalThisReceipt, delta: damagedQty,
          reason: 'damaged', note: `Damaged on arrival — PO #${po.poNumber}`,
          adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
        }], { session });
      }
    }

    const fullyReceived = (po.items as any[]).every((i) => (i.quantityReceived + i.quantityDamaged) >= i.quantityOrdered);
    po.status = fullyReceived ? 'received' : 'partially_received';
    if (fullyReceived) po.receivedAt = new Date();
    if (dto.requestId) po.receivedRequestIds = [...(po.receivedRequestIds ?? []).slice(-49), dto.requestId];
    await po.save({ session });

    return { po: po.toObject(), discrepancies, duplicate: false };
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
