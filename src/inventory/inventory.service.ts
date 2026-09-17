import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { toCsv, parseCsv } from '@/analytics/utils/csv.util';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { STOCK_ADJUSTMENT_REASONS, type StockAdjustmentReason } from './schemas/stock-adjustment.schema';
import { forecastDailyDemand } from './demand-forecast.util';

@Injectable()
export class InventoryService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getStoreInventory(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    // seller ka store he ya nahi
    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const lowStockThreshold = store.lowStockThreshold ?? 10;

    // filters
    const filter: any = { storeId, sellerId, isDelete: false };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.status && query.status !== 'all') filter.status = query.status;

    const page = parseInt(query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const totalProducts = await productModel.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / limit);

    const products = await productModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // har product ke variants fetch karo
    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();

    // productId → variants map
    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    // stats counters
    let inStock = 0;
    let lowStock = 0;
    let outOfStock = 0;

    const productList = products.map((product: any) => {
      const variants = variantMap[product._id.toString()] || [];
      const isDigital = product.type === 'digital';
      const hasUnlimitedVariant = variants.some((v: any) => v.unlimitedStock);

      let stockDisplay: string | number = '∞ Unlimited';
      let stockStatus = 'active';
      let price = 0;

      if (!isDigital && !hasUnlimitedVariant) {
        const totalStock = variants.reduce(
          (sum: number, v: any) => sum + (v.stock || 0),
          0,
        );
        stockDisplay = totalStock;

        // Status/stats classification uses real AVAILABLE stock (stock -
        // committed) — a product showing "10 in stock" here while all 10
        // are already reserved by pending orders has nothing left to
        // actually sell, and the In/Low/Out-of-Stock counters exist to
        // reflect that real sellability, not raw on-hand count (which is
        // still what the `stock` number itself displays, matching a real
        // Products list's convention). See ProductVariant.committedStock.
        const totalAvailable = Math.max(
          0,
          variants.reduce((sum: number, v: any) => sum + ((v.stock || 0) - (v.committedStock || 0) - (v.damagedStock || 0) - (v.inTransitStock || 0)), 0),
        );

        if (totalAvailable === 0) {
          stockStatus = 'out_of_stock';
          outOfStock++;
        } else if (totalAvailable <= lowStockThreshold) {
          stockStatus = 'low_stock';
          lowStock++;
          inStock++;
        } else {
          stockStatus = 'active';
          inStock++;
        }
      } else {
        inStock++; // digital, or has an unlimited-stock variant — always in stock
      }

      // default variant ki price, fallback to min price
      const defaultVariant =
        variants.find((v: any) => v.isDefault) || variants[0];
      price = defaultVariant?.price || 0;

      // default variant ka sku
      const sku = defaultVariant?.sku || null;

      const prices = variants
        .map((v: any) => v.price)
        .filter((p: any) => typeof p === 'number');
      const minPrice = prices.length ? Math.min(...prices) : price;
      const maxPrice = prices.length ? Math.max(...prices) : price;

      return {
        productId: product._id,
        sku,
        name: product.name,
        description: product.description ?? null,
        image: product.images?.[0] ?? null,
        images: product.images ?? [],
        type: product.type,
        productType: product.productType,
        stock: stockDisplay,
        stockStatus,
        status: product.status,
        scheduledAt: product.scheduledAt ?? null,
        price,
        compareAtPrice: defaultVariant?.compareAtPrice ?? null,
        allTimeSales: product.purchaseCount || 0,
        tags: product.tags ?? [],
        // physical-only (defaultVariant fields)
        options: defaultVariant?.options ?? [],
        shippingWeight: defaultVariant?.shippingWeight ?? null,
        variantCount: variants.length,
        minPrice,
        maxPrice,
        // digital-only — full config so re-opening Edit repopulates correctly
        digital: product.digital ?? null,
      };
    });

    return {
      success: true,
      data: {
        stats: {
          totalProducts,
          inStock,
          lowStock,
          outOfStock,
        },
        pagination: {
          page,
          limit,
          totalPages,
          totalProducts,
        },
        products: productList,
      },
    };
  }

  /** Real CSV export for the whole store's inventory (unpaginated — the
   *  "Export" button on the Inventory page previously had no handler at all
   *  and did nothing when clicked, found during the Catalog audit). Same
   *  product/variant aggregation as getStoreInventory above, just without
   *  the page/limit — a seller exporting genuinely wants every product, not
   *  whatever page they happened to be viewing. */
  async exportInventoryCsv(sellerId: string, storeId: string): Promise<string> {
    if (!storeId) throw new BadRequestException('storeId is required');
    const { productModel, productVariantModel, storeModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const products = await productModel
      .find({ storeId, sellerId, isDelete: false })
      .sort({ createdAt: -1 })
      .lean();
    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();
    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    const rows: (string | number)[][] = [];
    for (const product of products as any[]) {
      const variants = variantMap[product._id.toString()] || [];
      const isDigital = product.type === 'digital';
      const hasUnlimitedVariant = variants.some((v: any) => v.unlimitedStock);
      const defaultVariant = variants.find((v: any) => v.isDefault) || variants[0];
      const stock = isDigital || hasUnlimitedVariant
        ? 'Unlimited'
        : variants.reduce((sum: number, v: any) => sum + (v.stock || 0), 0);
      rows.push([
        product.name,
        defaultVariant?.sku ?? '',
        product.type,
        product.status,
        defaultVariant?.price ?? 0,
        stock,
        product.purchaseCount || 0,
      ]);
    }

    return toCsv(
      ['Name', 'SKU', 'Type', 'Status', 'Price', 'Stock', 'All-Time Sales'],
      rows,
    );
  }

  /** POST api/inventory/:storeId/import-stock-csv — real bulk stock
   *  RECONCILIATION, deliberately separate from `ProductsService.
   *  importProductsCsv` (which only ever CREATES new products — re-
   *  uploading a CSV of existing SKUs there would create duplicates, not
   *  update their stock, a real gap found in this pass). Columns: `SKU,
   *  Quantity` — an ABSOLUTE count (matches a real physical stock-take
   *  export/re-import workflow), matched against this store's existing
   *  SKUs. Same `created[]`/`failed[]` report shape `importProductsCsv`
   *  already returns, so the frontend result-summary UI is identical. */
  async importStockCsv(sellerId: string, storeId: string, csvText: string) {
    if (!storeId) throw new BadRequestException('storeId is required');
    const { productModel, productVariantModel, storeModel, stockAdjustmentModel, sellerModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const rows = parseCsv(csvText);
    if (rows.length === 0) throw new BadRequestException('The CSV file has no data rows.');
    if (rows.length > 1000) {
      throw new BadRequestException('A single import is capped at 1000 rows — split larger reconciliations into multiple files.');
    }

    const products = await productModel.find({ storeId, sellerId, isDelete: false }).select('name').lean();
    const productIds = products.map((p: any) => p._id.toString());
    const productById = new Map<string, any>(products.map((p: any) => [p._id.toString(), p]));
    const variants = productIds.length
      ? await productVariantModel.find({ productId: { $in: productIds }, isDelete: false })
      : [];
    const variantBySku = new Map(variants.map((v: any) => [v.sku, v]));

    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');
    const updated: { row: number; sku: string }[] = [];
    const failed: { row: number; sku: string; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNumber = i + 2;
      const sku = (r['SKU'] ?? '').trim();
      const qtyRaw = (r['Quantity'] ?? '').trim();
      const qty = parseInt(qtyRaw, 10);

      if (!sku) { failed.push({ row: rowNumber, sku: '(blank)', error: 'SKU is required' }); continue; }
      if (!Number.isFinite(qty) || qty < 0) { failed.push({ row: rowNumber, sku, error: 'Quantity must be a non-negative number' }); continue; }

      const variant: any = variantBySku.get(sku);
      if (!variant) { failed.push({ row: rowNumber, sku, error: 'No SKU matches this in your store' }); continue; }
      if (variant.unlimitedStock) { failed.push({ row: rowNumber, sku, error: 'This SKU has unlimited stock — skipped' }); continue; }
      if (qty === variant.stock) { updated.push({ row: rowNumber, sku }); continue; } // no real change — still counts as a success, not a failure

      const previousStock = variant.stock;
      const delta = qty - previousStock;
      await productVariantModel.updateOne({ _id: variant._id }, { $set: { stock: qty } });
      await stockAdjustmentModel.create({
        storeId, productId: variant.productId, variantId: variant._id.toString(), locationId: null,
        productName: productById.get(variant.productId)?.name ?? '(deleted product)', sku: variant.sku,
        previousStock, newStock: qty, delta,
        reason: 'correction', note: 'Bulk CSV reconciliation',
        adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
      });
      updated.push({ row: rowNumber, sku });
    }

    return {
      success: true,
      message: `Reconciled ${updated.length} of ${rows.length} SKU(s).`,
      data: { updatedCount: updated.length, totalRows: rows.length, updated, failed },
    };
  }

  // Store-wide low-stock summary for the seller dashboard's alert card —
  // unlike getStoreInventory above, this isn't paginated (it needs the true
  // store-wide count/list, not just the current page) and only returns the
  // items that actually need attention. Digital products are excluded —
  // they always have `stock: 0` and would otherwise show up as permanently
  // low/out of stock.
  async getLowStockSummary(sellerId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const lowStockThreshold = store.lowStockThreshold ?? 10;

    const products = await productModel
      .find({
        storeId,
        sellerId,
        isDelete: false,
        status: 'active',
        type: { $ne: 'digital' },
      })
      .select('name')
      .lean();

    const productIds = products.map((p: any) => p._id.toString());
    const variants = productIds.length
      ? await productVariantModel
          .find({ productId: { $in: productIds }, isDelete: false })
          .select('productId stock committedStock damagedStock inTransitStock unlimitedStock')
          .lean()
      : [];

    // Uses real AVAILABLE stock (stock - committed - damaged), not raw
    // on-hand — a product that's technically "5 in stock" but all 5
    // already promised to pending orders (or sitting damaged) genuinely
    // has nothing left to sell right now, and this alert exists
    // specifically to warn about that (see ProductVariant.committedStock/
    // damagedStock, and getStockLines' identical reasoning).
    const availableByProduct = new Map<string, number>();
    const unlimitedProducts = new Set<string>();
    for (const v of variants) {
      if ((v as any).unlimitedStock) {
        unlimitedProducts.add(v.productId);
        continue;
      }
      const available = Math.max(0, (v.stock || 0) - ((v as any).committedStock || 0) - ((v as any).damagedStock || 0) - ((v as any).inTransitStock || 0));
      availableByProduct.set(v.productId, (availableByProduct.get(v.productId) ?? 0) + available);
    }

    const items = products
      .filter((p: any) => !unlimitedProducts.has(p._id.toString()))
      .map((p: any) => ({
        productId: p._id,
        name: p.name,
        stock: availableByProduct.get(p._id.toString()) ?? 0,
      }))
      .filter((p) => p.stock > 0 && p.stock <= lowStockThreshold)
      .sort((a, b) => a.stock - b.stock);

    return {
      success: true,
      data: {
        count: items.length,
        threshold: lowStockThreshold,
        items,
      },
    };
  }

  /** GET api/inventory/:storeId/stock-lines — the real, variant-level
   *  Inventory table (one row per SKU, not one row per product summed
   *  across its variants like `getStoreInventory` above — that endpoint
   *  stays as-is since the Products list still needs a product-level view;
   *  this one is Inventory's own, dedicated to actual stock management).
   *
   *  Real DB-level pagination via one aggregation pipeline (join to
   *  `products` + `$facet` for page/stats) — the previous version fetched
   *  EVERY variant for the store into memory, built the full lines array,
   *  then `.slice()`d the page in JS. Fine at hundreds of SKUs, a genuine
   *  problem at the thousands-of-SKUs scale this module targets. `status`/
   *  `available` are computed in the pipeline itself (not in JS after the
   *  fact) so search/status-filter/stats all operate on the same real
   *  values without a second pass over the data. `productId` is stored as a
   *  string on ProductVariant but as a real ObjectId `_id` on Product, so
   *  the $lookup needs an explicit $toObjectId conversion — every variant's
   *  `productId` is always a real product _id.toString() set at creation,
   *  so this conversion is safe (never a hand-typed/foreign value). */
  async getStockLines(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');
    const { productVariantModel, storeModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const lowStockThreshold = store.lowStockThreshold ?? 10;

    const search = (query.search ?? '').trim();
    const statusFilter: string | undefined = ['in_stock', 'low_stock', 'out_of_stock', 'unlimited'].includes(query.status)
      ? query.status
      : undefined;
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.max(1, parseInt(query.limit) || 20);

    const available = {
      $max: [0, {
        $subtract: [
          { $subtract: [{ $subtract: ['$stock', { $ifNull: ['$committedStock', 0] }] }, { $ifNull: ['$damagedStock', 0] }] },
          { $ifNull: ['$inTransitStock', 0] },
        ],
      }],
    };
    const effectiveThreshold = { $ifNull: ['$reorderPoint', lowStockThreshold] };
    const statusExpr = {
      $switch: {
        branches: [
          { case: { $eq: ['$unlimitedStock', true] }, then: 'unlimited' },
          { case: { $eq: [available, 0] }, then: 'out_of_stock' },
          { case: { $lte: [available, effectiveThreshold] }, then: 'low_stock' },
        ],
        default: 'in_stock',
      },
    };

    const pipeline: any[] = [
      { $match: { isDelete: false } },
      { $addFields: { productObjId: { $toObjectId: '$productId' } } },
      { $lookup: { from: 'products', localField: 'productObjId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $match: { 'product.storeId': storeId, 'product.sellerId': sellerId, 'product.isDelete': false, 'product.type': { $ne: 'digital' } } },
    ];
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pipeline.push({ $match: { $or: [{ sku: { $regex: escaped, $options: 'i' } }, { 'product.name': { $regex: escaped, $options: 'i' } }] } });
    }
    pipeline.push({
      $addFields: {
        computedAvailable: available,
        computedStatus: statusExpr,
      },
    });
    if (statusFilter) pipeline.push({ $match: { computedStatus: statusFilter } });
    pipeline.push({
      $facet: {
        data: [
          { $sort: { productId: 1, isDefault: -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              variantId: '$_id',
              productId: 1,
              productName: '$product.name',
              image: { $ifNull: [{ $arrayElemAt: ['$product.images', 0] }, null] },
              sku: 1,
              options: 1,
              price: 1,
              stock: 1,
              committedStock: { $ifNull: ['$committedStock', 0] },
              damagedStock: { $ifNull: ['$damagedStock', 0] },
              inTransitStock: { $ifNull: ['$inTransitStock', 0] },
              available: '$computedAvailable',
              unlimitedStock: { $ifNull: ['$unlimitedStock', false] },
              status: '$computedStatus',
              reorderPoint: 1,
              costPrice: 1,
              allowBackorder: { $ifNull: ['$allowBackorder', false] },
              trackLots: { $ifNull: ['$trackLots', false] },
              trackSerials: { $ifNull: ['$trackSerials', false] },
            },
          },
        ],
        totalCount: [{ $count: 'count' }],
        statusCounts: [{ $group: { _id: '$computedStatus', count: { $sum: 1 } } }],
      },
    });

    const [result] = await productVariantModel.aggregate(pipeline);
    const lines = (result?.data ?? []).map((l: any) => ({ ...l, variantId: l.variantId.toString() }));
    const total = result?.totalCount?.[0]?.count ?? 0;
    const countsByStatus: Record<string, number> = {};
    for (const c of result?.statusCounts ?? []) countsByStatus[c._id] = c.count;

    const stats = {
      totalLines: total,
      inStock: (countsByStatus['in_stock'] ?? 0) + (countsByStatus['unlimited'] ?? 0),
      lowStock: countsByStatus['low_stock'] ?? 0,
      outOfStock: countsByStatus['out_of_stock'] ?? 0,
    };

    return {
      success: true,
      data: { stats, pagination: { page, limit, total }, lines },
    };
  }

  /** PATCH api/inventory/:storeId/variant/:variantId/adjust — the real,
   *  seller-initiated stock change this Inventory page was missing
   *  entirely (previously the only way to change stock was to open the
   *  full Edit Product form). Every adjustment is reason-coded and
   *  written to a permanent `StockAdjustment` audit row — never a silent
   *  overwrite. Deliberately separate from the checkout/POS decrement path
   *  (that one is guarded/atomic for concurrency; this one is a single
   *  seller acting on their own dashboard, so a simple optimistic
   *  read-then-write check is enough — see the race-guard comment below). */
  /** Public entry point — routes a STAFF caller (see StaffMember/
   *  PermissionsGuard) without `inventory.approve` through the approval
   *  queue instead of mutating real stock directly, whenever the
   *  adjustment is large (`|delta| >= Store.staffApprovalThreshold`) or a
   *  'damaged'/'write_off' reason (any quantity — these permanently affect
   *  valuation/loss accounting, so they're always reviewed). A seller/admin
   *  caller, or a staff member WHO DOES hold `inventory.approve`, always
   *  applies immediately — identical behavior to before Staff RBAC existed. */
  async adjustStock(
    sellerId: string,
    storeId: string,
    variantId: string,
    delta: number,
    reason: StockAdjustmentReason,
    note?: string,
    locationId?: string,
    actor?: { actorId: string; actorRole: string; actorPermissions: string[] | null },
  ) {
    const requiresApproval =
      actor?.actorRole === 'staff' && !(actor.actorPermissions ?? []).includes('inventory.approve');

    if (requiresApproval) {
      const { storeModel, productModel, productVariantModel, approvalRequestModel, staffMemberModel } = this.databaseService.repositories;
      const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
      if (!store) throw new ForbiddenException('Store not found or unauthorized');
      const threshold = (store as any).staffApprovalThreshold ?? 20;
      const needsApproval = reason === 'damaged' || reason === 'write_off' || Math.abs(delta) >= threshold;

      if (needsApproval) {
        const variant = await productVariantModel.findOne({ _id: variantId, isDelete: false }).lean();
        if (!variant) throw new NotFoundException('Variant not found');
        const product = await productModel.findOne({ _id: (variant as any).productId }).select('name').lean();
        const staff = await staffMemberModel.findById(actor!.actorId).select('name').lean();

        const approval = await approvalRequestModel.create({
          storeId, type: 'stock_adjustment',
          payload: { sellerId, storeId, variantId, delta, reason, note: note ?? null, locationId: locationId ?? null },
          summary: `${delta > 0 ? '+' : ''}${delta} unit(s) — ${reason} — ${(product as any)?.name ?? 'Unknown product'}${(variant as any).sku ? ` (${(variant as any).sku})` : ''}`,
          requestedBy: actor!.actorId, requestedByName: (staff as any)?.name ?? null,
          status: 'pending',
        });

        return {
          success: true,
          message: 'This adjustment requires manager approval — submitted to the approval queue',
          data: { pending: true, approval },
        };
      }
    }

    return this.applyStockAdjustment(sellerId, storeId, variantId, delta, reason, note, locationId);
  }

  /** GET api/inventory/:storeId/approvals — pending (or, with `?status=`,
   *  approved/rejected) staff-submitted adjustment requests, newest first. */
  async listApprovals(sellerId: string, storeId: string, status?: string) {
    const { storeModel, approvalRequestModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const filter: any = { storeId };
    if (status && status !== 'all') filter.status = status;
    else if (!status) filter.status = 'pending';

    const items = await approvalRequestModel.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return { success: true, data: items };
  }

  /** Applies the SNAPSHOTTED original adjustment verbatim — never re-derives
   *  it from current state, which may have changed since the request was
   *  raised (e.g. a different adjustment already happened in the meantime;
   *  `applyStockAdjustment`'s own optimistic/atomic guards still protect
   *  against a genuinely stale mutation, exactly as they do for a direct
   *  seller adjustment). */
  async approveRequest(sellerId: string, storeId: string, approvalId: string, reviewerId: string, reviewerRole: string) {
    const { storeModel, approvalRequestModel, sellerModel, staffMemberModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const approval = await approvalRequestModel.findOne({ _id: approvalId, storeId });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.status !== 'pending') {
      throw new BadRequestException(`This request was already ${approval.status}`);
    }

    const p = approval.payload as any;
    const result = await this.applyStockAdjustment(p.sellerId, p.storeId, p.variantId, p.delta, p.reason, p.note, p.locationId);

    const reviewer = reviewerRole === 'staff'
      ? await staffMemberModel.findById(reviewerId).select('name').lean()
      : await sellerModel.findById(reviewerId).select('name').lean();
    approval.status = 'approved';
    approval.reviewedBy = reviewerId;
    approval.reviewedByName = (reviewer as any)?.name ?? null;
    approval.reviewedAt = new Date();
    await approval.save();

    return { success: true, message: 'Approved and applied', data: { approval: approval.toObject(), result: result.data } };
  }

  async rejectRequest(sellerId: string, storeId: string, approvalId: string, reviewerId: string, reviewerRole: string, reason?: string) {
    const { storeModel, approvalRequestModel, sellerModel, staffMemberModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const approval = await approvalRequestModel.findOne({ _id: approvalId, storeId });
    if (!approval) throw new NotFoundException('Approval request not found');
    if (approval.status !== 'pending') {
      throw new BadRequestException(`This request was already ${approval.status}`);
    }

    const reviewer = reviewerRole === 'staff'
      ? await staffMemberModel.findById(reviewerId).select('name').lean()
      : await sellerModel.findById(reviewerId).select('name').lean();
    approval.status = 'rejected';
    approval.reviewedBy = reviewerId;
    approval.reviewedByName = (reviewer as any)?.name ?? null;
    approval.reviewedAt = new Date();
    approval.rejectionReason = reason?.trim() || null;
    await approval.save();

    return { success: true, message: 'Rejected — nothing was applied', data: approval.toObject() };
  }

  /** The real, previously-monolithic `adjustStock` body — now the single
   *  place that ACTUALLY mutates stock, called either directly (seller/
   *  admin, or a staff member with `inventory.approve`) or via
   *  `approveRequest` with a snapshotted payload. Unchanged from before
   *  Staff RBAC existed. */
  private async applyStockAdjustment(
    sellerId: string,
    storeId: string,
    variantId: string,
    delta: number,
    reason: StockAdjustmentReason,
    note?: string,
    locationId?: string,
  ) {
    const { storeModel, productModel, productVariantModel, stockAdjustmentModel, sellerModel, variantLocationStockModel, storeLocationModel } =
      this.databaseService.repositories;

    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException('Adjustment quantity must be a non-zero number');
    }
    if (!STOCK_ADJUSTMENT_REASONS.includes(reason)) {
      throw new BadRequestException('Invalid adjustment reason');
    }

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const variant = await productVariantModel.findOne({ _id: variantId, isDelete: false });
    if (!variant) throw new NotFoundException('Variant not found');
    const product = await productModel.findOne({ _id: variant.productId, storeId, isDelete: false });
    if (!product) throw new ForbiddenException('That variant does not belong to your store');
    if (variant.unlimitedStock) {
      throw new BadRequestException('This variant has unlimited stock — quantity adjustments don\'t apply');
    }

    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');

    // 'damaged'/'write_off' move units between real on-hand `stock` and the
    // separate unsellable `damagedStock` pool — never a per-location
    // VariantLocationStock row (damagedStock, like committedStock, is
    // tracked store-wide per variant only — see the schema's doc comment).
    if (reason === 'damaged' || reason === 'write_off') {
      if (locationId) {
        throw new BadRequestException(`A "${reason}" adjustment applies to the variant as a whole, not one location — omit locationId`);
      }
      if (delta > 0) {
        throw new BadRequestException(`A "${reason}" adjustment only removes units — quantity must be negative`);
      }
      const qty = Math.abs(delta);
      const previousStock = variant.stock;
      const previousDamaged = variant.damagedStock || 0;

      if (reason === 'damaged') {
        // Units stay on-hand (`stock` unchanged) — they just move out of the
        // sellable pool. Can't mark more damaged than is currently sellable.
        const sellableAvailable = Math.max(0, previousStock - (variant.committedStock || 0) - previousDamaged);
        if (qty > sellableAvailable) {
          throw new BadRequestException(
            `Cannot mark ${qty} unit(s) damaged — only ${sellableAvailable} sellable unit(s) available`,
          );
        }
        const result = await productVariantModel.updateOne(
          { _id: variantId, damagedStock: previousDamaged },
          { $set: { damagedStock: previousDamaged + qty } },
        );
        if (result.modifiedCount === 0) {
          throw new BadRequestException('Stock was changed by another action just now — please refresh and try again');
        }
        const adjustment = await stockAdjustmentModel.create({
          storeId, productId: variant.productId, variantId, locationId: null,
          productName: product.name, sku: variant.sku,
          previousStock, newStock: previousStock, delta, reason,
          note: note?.trim() || null, adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
        });
        return {
          success: true, message: 'Marked as damaged — moved out of sellable stock',
          data: { variantId, previousStock, newStock: previousStock, adjustment },
        };
      }

      // 'write_off' — permanently discards units already sitting in the
      // damaged pool: both damagedStock AND real on-hand `stock` drop
      // together, since the units are genuinely gone (thrown away/disposed),
      // not just unsellable any more.
      if (qty > previousDamaged) {
        throw new BadRequestException(`Cannot write off ${qty} unit(s) — only ${previousDamaged} damaged unit(s) on record`);
      }
      const newStock = Math.max(0, previousStock - qty);
      const result = await productVariantModel.updateOne(
        { _id: variantId, damagedStock: previousDamaged, stock: previousStock },
        { $set: { damagedStock: previousDamaged - qty, stock: newStock } },
      );
      if (result.modifiedCount === 0) {
        throw new BadRequestException('Stock was changed by another action just now — please refresh and try again');
      }
      const adjustment = await stockAdjustmentModel.create({
        storeId, productId: variant.productId, variantId, locationId: null,
        productName: product.name, sku: variant.sku,
        previousStock, newStock, delta, reason,
        note: note?.trim() || null, adjustedBy: sellerId, adjustedByName: seller?.name ?? null,
      });
      return { success: true, message: 'Units written off', data: { variantId, previousStock, newStock, adjustment } };
    }

    const previousStock = variant.stock;
    let newStock: number;

    if (locationId) {
      // Multi-location path — only reachable once a store has 2+ real
      // StoreLocations (see StoreLocation/VariantLocationStock docs).
      // Adjust that ONE location's row; `ProductVariant.stock` stays the
      // auto-maintained sum across every location row for this variant.
      const location = await storeLocationModel.findOne({ _id: locationId, storeId, isDelete: false });
      if (!location) throw new NotFoundException('Location not found');

      await this.ensureLocationStockSeeded(storeId, variantId, variant);
      const row = await variantLocationStockModel.findOne({ variantId, locationId });
      const previousLocationStock = row?.stock ?? 0;
      const newLocationStock = previousLocationStock + delta;
      if (newLocationStock < 0) {
        throw new BadRequestException(`Cannot reduce "${location.name}" stock below 0 (current: ${previousLocationStock})`);
      }
      await variantLocationStockModel.updateOne(
        { variantId, locationId },
        { $set: { storeId, productId: variant.productId, stock: newLocationStock } },
        { upsert: true },
      );

      // `stock` (the aggregate total) = sum of every location row + whatever
      // is currently mid-transfer (see ProductVariant.inTransitStock) — not
      // just the location rows alone, or a seller shipping a transfer and
      // then making an unrelated location adjustment on the same SKU would
      // silently erase the in-transit quantity from the visible total.
      const allRows = await variantLocationStockModel.find({ variantId }).lean();
      newStock = allRows.reduce((sum, r: any) => sum + (r.stock || 0), 0) + (variant.inTransitStock || 0);
    } else {
      newStock = previousStock + delta;
    }

    if (newStock < 0) {
      throw new BadRequestException(`Cannot reduce stock below 0 (current: ${previousStock})`);
    }
    // Can't manually reduce stock below what's already reserved by a
    // paid-but-unshipped order — see ProductVariant.committedStock.
    if (newStock < (variant.committedStock || 0)) {
      throw new BadRequestException(
        `Cannot reduce stock below ${variant.committedStock} — that many units are already reserved by pending orders`,
      );
    }

    if (locationId) {
      await productVariantModel.updateOne({ _id: variantId }, { $set: { stock: newStock } });
    } else {
      // Optimistic guard: only writes if `stock` hasn't changed since we
      // read it a moment ago — catches the rare case of two seller
      // tabs/staff adjusting the same SKU at the same instant, without
      // needing the heavier atomic $inc-with-floor pattern checkout/POS
      // use (this is a single dashboard action, not a high-concurrency
      // buyer-facing path).
      const result = await productVariantModel.updateOne(
        { _id: variantId, stock: previousStock },
        { $set: { stock: newStock } },
      );
      if (result.modifiedCount === 0) {
        throw new BadRequestException('Stock was changed by another action just now — please refresh and try again');
      }
    }

    const adjustment = await stockAdjustmentModel.create({
      storeId,
      productId: variant.productId,
      variantId,
      locationId: locationId ?? null,
      productName: product.name,
      sku: variant.sku,
      previousStock,
      newStock,
      delta,
      reason,
      note: note?.trim() || null,
      adjustedBy: sellerId,
      adjustedByName: seller?.name ?? null,
    });

    // Real FIFO/FEFO lot consumption for a genuine reduction of sellable
    // stock (restocked/correction/other going negative — 'damaged'/
    // 'write_off' are handled in their own early-return branch above and
    // deliberately don't touch lots, see that branch's own scope note).
    // Best-effort — a lot-drain failure here never blocks the real,
    // already-committed stock write above.
    if ((variant as any).trackLots && delta < 0) {
      try {
        await this.consumeLotsFifo(variantId, Math.abs(delta));
      } catch {
        // Non-fatal — see comment above.
      }
    }

    return {
      success: true,
      message: 'Stock adjusted successfully',
      data: { variantId, previousStock, newStock, adjustment },
    };
  }

  /** GET api/inventory/:storeId/variant/:variantId/history — a real,
   *  permanent audit trail per SKU (Shopify's "Inventory History"
   *  equivalent) — never existed before since stock could only ever be
   *  changed via the Edit Product form, which left no trace of who
   *  changed what or why. */
  async getStockHistory(sellerId: string, storeId: string, variantId: string, page = 1, limit = 20) {
    const { storeModel, stockAdjustmentModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const filter = { storeId, variantId };
    const total = await stockAdjustmentModel.countDocuments(filter);
    const items = await stockAdjustmentModel
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    return {
      success: true,
      data: { pagination: { page, limit, total }, items },
    };
  }

  // ── Multi-location stock (only relevant once a store has 2+ real
  // StoreLocations — see StoreLocation/VariantLocationStock docs). A
  // single-location store never calls any of these; its Inventory page
  // stays exactly the simple, single-number view it always was. ──────────

  /** Lazily seeds a variant's FIRST-ever location split: if no
   *  VariantLocationStock rows exist yet for this variant, its whole
   *  current `stock` is assigned to the store's default location — so a
   *  pre-existing product doesn't just silently show 0 everywhere the
   *  first time a seller looks at it by location. Public — PurchaseOrdersService
   *  reuses this exact helper for receiving instead of duplicating it. */
  async ensureLocationStockSeeded(storeId: string, variantId: string, variant: { productId: string; stock: number }) {
    const { variantLocationStockModel, storeLocationModel } = this.databaseService.repositories;
    const existing = await variantLocationStockModel.countDocuments({ variantId });
    if (existing > 0) return;

    const defaultLocation = await storeLocationModel.findOne({ storeId, isDelete: false, isDefault: true })
      ?? await storeLocationModel.findOne({ storeId, isDelete: false }).sort({ createdAt: 1 });
    if (!defaultLocation) return;

    await variantLocationStockModel.create({
      storeId,
      productId: variant.productId,
      variantId,
      locationId: (defaultLocation as any)._id.toString(),
      stock: variant.stock,
    });
  }

  // ── Bins (bin/shelf-level granularity within one location — see Bin
  // schema's own doc comment for the deliberately shallow scope). ────────

  async listBins(sellerId: string, storeId: string, locationId: string) {
    const { storeModel, binModel, storeLocationModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const location = await storeLocationModel.findOne({ _id: locationId, storeId, isDelete: false });
    if (!location) throw new NotFoundException('Location not found');

    const bins = await binModel.find({ locationId, isDelete: false }).sort({ code: 1 }).lean();
    return { success: true, data: bins };
  }

  async createBin(sellerId: string, storeId: string, locationId: string, body: { code: string; zone?: string; aisle?: string; shelf?: string }) {
    const { storeModel, binModel, storeLocationModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const location = await storeLocationModel.findOne({ _id: locationId, storeId, isDelete: false });
    if (!location) throw new NotFoundException('Location not found');

    const code = (body.code ?? '').trim();
    if (!code) throw new BadRequestException('A bin code is required');
    const existing = await binModel.findOne({ locationId, code, isDelete: false });
    if (existing) throw new BadRequestException(`A bin with code "${code}" already exists at this location`);

    const bin = await binModel.create({
      storeId, locationId, code,
      zone: body.zone?.trim() || null, aisle: body.aisle?.trim() || null, shelf: body.shelf?.trim() || null,
    });
    return { success: true, data: bin };
  }

  async deleteBin(sellerId: string, storeId: string, binId: string) {
    const { storeModel, binModel, variantLocationStockModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const bin = await binModel.findOne({ _id: binId, storeId, isDelete: false });
    if (!bin) throw new NotFoundException('Bin not found');

    const stockRows = await variantLocationStockModel.find({ binId, stock: { $gt: 0 } }).limit(1).lean();
    if (stockRows.length > 0) {
      throw new BadRequestException('This bin still has stock assigned to it — move or count it out before deleting the bin');
    }

    bin.isDelete = true;
    await bin.save();
    return { success: true, message: 'Bin deleted' };
  }

  /** GET api/inventory/:storeId/variant/:variantId/locations — real
   *  per-branch stock breakdown for one SKU. Only meaningful once the
   *  store has 2+ active locations — the frontend only shows this option
   *  in that case. Each location also carries its own `bins` breakdown
   *  (empty array when that location has no real Bins defined yet). */
  async getVariantLocations(sellerId: string, storeId: string, variantId: string) {
    const { storeModel, productVariantModel, variantLocationStockModel, storeLocationModel, binModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const variant = await productVariantModel.findOne({ _id: variantId, isDelete: false });
    if (!variant) throw new NotFoundException('Variant not found');

    await this.ensureLocationStockSeeded(storeId, variantId, variant);

    const [locations, rows, bins] = await Promise.all([
      storeLocationModel.find({ storeId, isDelete: false, status: 'active' }).sort({ createdAt: 1 }).lean(),
      variantLocationStockModel.find({ variantId }).lean(),
      binModel.find({ storeId, isDelete: false }).lean(),
    ]);
    // A location can now have MORE THAN ONE row for the same variant (one
    // per bin — see VariantLocationStock.binId) — sum them, never assume
    // exactly one row per location.
    const stockByLocation = new Map<string, number>();
    const stockByBin = new Map<string, number>();
    for (const r of rows as any[]) {
      stockByLocation.set(r.locationId, (stockByLocation.get(r.locationId) ?? 0) + (r.stock || 0));
      if (r.binId) stockByBin.set(r.binId, (stockByBin.get(r.binId) ?? 0) + (r.stock || 0));
    }
    const binsByLocation = new Map<string, any[]>();
    for (const b of bins as any[]) {
      const list = binsByLocation.get(b.locationId) ?? [];
      list.push({ binId: b._id.toString(), code: b.code, zone: b.zone, aisle: b.aisle, shelf: b.shelf, stock: stockByBin.get(b._id.toString()) ?? 0 });
      binsByLocation.set(b.locationId, list);
    }

    return {
      success: true,
      data: {
        variantId,
        totalStock: variant.stock,
        inTransitStock: variant.inTransitStock || 0,
        damagedStock: variant.damagedStock || 0,
        locations: locations.map((l: any) => ({
          locationId: l._id.toString(),
          locationName: l.name,
          locationType: l.type ?? 'store',
          isDefault: !!l.isDefault,
          stock: stockByLocation.get(l._id.toString()) ?? 0,
          bins: binsByLocation.get(l._id.toString()) ?? [],
        })),
      },
    };
  }

  /** GET api/inventory/:storeId/locations — active locations for this
   *  store, so the frontend knows whether to show location-aware controls
   *  at all (2+ active locations) or stay in the simple single-number
   *  view (0 or 1). Read-only pass-through — location CRUD itself already
   *  exists at `api/pos/locations/:storeId` (built for POS, reused as-is). */
  async listActiveLocations(sellerId: string, storeId: string) {
    const { storeModel, storeLocationModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const locations = await storeLocationModel
      .find({ storeId, isDelete: false, status: 'active' })
      .sort({ createdAt: 1 })
      .lean();
    return { success: true, data: locations };
  }

  /** POST api/inventory/:storeId/variant/:variantId/transfer/ship — real
   *  branch-to-branch stock move, Shopify's own "Transfer" equivalent, now a
   *  genuine 2-step lifecycle (ship → later, receive) instead of an instant
   *  teleport — a real warehouse→store shipment takes days, so stock must
   *  leave the source right away without silently landing at the
   *  destination before anyone has actually received it there. The shipped
   *  quantity moves into `ProductVariant.inTransitStock` (see that field's
   *  doc comment) — `stock` itself (the aggregate total) is untouched
   *  either way, only which bucket currently holds it changes. */
  async shipTransfer(
    sellerId: string,
    storeId: string,
    variantId: string,
    fromLocationId: string,
    toLocationId: string,
    quantity: number,
    note?: string,
    shipping?: { carrier?: string; trackingNumber?: string; trackingUrl?: string },
  ) {
    const { storeModel, productModel, productVariantModel, variantLocationStockModel, storeLocationModel, stockTransferModel, sellerModel } =
      this.databaseService.repositories;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('Transfer quantity must be greater than 0');
    }
    if (fromLocationId === toLocationId) {
      throw new BadRequestException('Source and destination locations must be different');
    }

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const variant = await productVariantModel.findOne({ _id: variantId, isDelete: false });
    if (!variant) throw new NotFoundException('Variant not found');
    const product = await productModel.findOne({ _id: variant.productId, storeId, isDelete: false });
    if (!product) throw new ForbiddenException('That variant does not belong to your store');

    const [fromLocation, toLocation] = await Promise.all([
      storeLocationModel.findOne({ _id: fromLocationId, storeId, isDelete: false }),
      storeLocationModel.findOne({ _id: toLocationId, storeId, isDelete: false }),
    ]);
    if (!fromLocation) throw new NotFoundException('Source location not found');
    if (!toLocation) throw new NotFoundException('Destination location not found');

    await this.ensureLocationStockSeeded(storeId, variantId, variant);

    // Atomic, floor-guarded decrement at the source — mirrors the same
    // race-safety pattern checkout/POS use, since a transfer can in
    // principle be triggered from more than one staff session at once.
    const decResult = await variantLocationStockModel.updateOne(
      { variantId, locationId: fromLocationId, stock: { $gte: quantity } },
      { $inc: { stock: -quantity } },
    );
    if (decResult.modifiedCount === 0) {
      throw new BadRequestException(`Not enough stock at "${fromLocation.name}" to transfer ${quantity} unit(s)`);
    }
    await productVariantModel.updateOne({ _id: variantId }, { $inc: { inTransitStock: quantity } });

    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');

    const transfer = await stockTransferModel.create({
      storeId,
      productId: variant.productId,
      variantId,
      productName: product.name,
      sku: variant.sku,
      fromLocationId,
      fromLocationName: fromLocation.name,
      toLocationId,
      toLocationName: toLocation.name,
      quantity,
      receivedQuantity: 0,
      status: 'in_transit',
      note: note?.trim() || null,
      transferredBy: sellerId,
      transferredByName: seller?.name ?? null,
      carrier: shipping?.carrier?.trim() || null,
      trackingNumber: shipping?.trackingNumber?.trim() || null,
      trackingUrl: shipping?.trackingUrl?.trim() || null,
    });

    return { success: true, message: 'Stock shipped — now in transit', data: transfer };
  }

  /** Real "Manage shipments" — lets a seller add/edit carrier/tracking
   *  details on an already-shipped transfer (e.g. a label was only booked
   *  after the truck left, or a courier's tracking number changed).
   *  Restricted to a still-`in_transit`/`partially_received` transfer —
   *  once fully received or cancelled, shipment details are historical. */
  async updateTransferShipping(
    sellerId: string,
    storeId: string,
    transferId: string,
    shipping: { carrier?: string; trackingNumber?: string; trackingUrl?: string },
  ) {
    const { storeModel, stockTransferModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const transfer = await stockTransferModel.findOne({ _id: transferId, storeId });
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status !== 'in_transit' && transfer.status !== 'partially_received') {
      throw new BadRequestException('Shipment details can only be edited while a transfer is still in transit.');
    }

    const update: Record<string, unknown> = {};
    if (shipping.carrier !== undefined) update.carrier = shipping.carrier.trim() || null;
    if (shipping.trackingNumber !== undefined) update.trackingNumber = shipping.trackingNumber.trim() || null;
    if (shipping.trackingUrl !== undefined) update.trackingUrl = shipping.trackingUrl.trim() || null;

    const updated = await stockTransferModel.findByIdAndUpdate(transferId, { $set: update }, { new: true });
    return { success: true, message: 'Shipment details updated', data: updated };
  }

  /** POST api/inventory/:storeId/transfer/:transferId/receive — settles some
   *  or all of an in-transit transfer at its destination. Callable more than
   *  once for a real multi-box/partial delivery, exactly like Purchase
   *  Order receiving. */
  async receiveTransfer(sellerId: string, storeId: string, transferId: string, receivedQty: number, binId?: string) {
    const { storeModel, productVariantModel, variantLocationStockModel, stockTransferModel, stockAdjustmentModel, sellerModel, binModel } =
      this.databaseService.repositories;

    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      throw new BadRequestException('Received quantity must be greater than 0');
    }

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const transfer = await stockTransferModel.findOne({ _id: transferId, storeId });
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status !== 'in_transit' && transfer.status !== 'partially_received') {
      throw new BadRequestException(`This transfer is already "${transfer.status}" — nothing left to receive`);
    }

    const remaining = transfer.quantity - transfer.receivedQuantity;
    if (receivedQty > remaining) {
      throw new BadRequestException(`Only ${remaining} unit(s) remain to receive on this transfer`);
    }

    let targetBinId: string | null = null;
    if (binId) {
      const bin = await binModel.findOne({ _id: binId, locationId: transfer.toLocationId, isDelete: false });
      if (!bin) throw new NotFoundException('Bin not found at the destination location');
      targetBinId = binId;
    }

    await variantLocationStockModel.updateOne(
      { variantId: transfer.variantId, locationId: transfer.toLocationId, binId: targetBinId },
      { $inc: { stock: receivedQty }, $setOnInsert: { storeId, productId: transfer.productId } },
      { upsert: true },
    );
    // inTransitStock floor-guarded at 0 via the pipeline $max — defensive
    // only; it should never actually go negative since receivedQty is
    // always bounded by `remaining` above.
    await productVariantModel.updateOne(
      { _id: transfer.variantId },
      [{ $set: { inTransitStock: { $max: [0, { $subtract: ['$inTransitStock', receivedQty] }] } } }],
      { updatePipeline: true } as any,
    );

    const newReceivedQuantity = transfer.receivedQuantity + receivedQty;
    const fullyReceived = newReceivedQuantity >= transfer.quantity;
    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');

    transfer.receivedQuantity = newReceivedQuantity;
    transfer.status = fullyReceived ? 'received' : 'partially_received';
    if (fullyReceived) {
      transfer.receivedAt = new Date();
      transfer.receivedBy = sellerId;
      transfer.receivedByName = seller?.name ?? null;
    }
    await transfer.save();

    await stockAdjustmentModel.create({
      storeId,
      productId: transfer.productId,
      variantId: transfer.variantId,
      locationId: transfer.toLocationId,
      productName: transfer.productName,
      sku: transfer.sku,
      previousStock: 0,
      newStock: 0,
      delta: receivedQty,
      reason: 'restocked',
      note: `Received via transfer from "${transfer.fromLocationName}"`,
      adjustedBy: sellerId,
      adjustedByName: seller?.name ?? null,
    });

    return { success: true, message: fullyReceived ? 'Transfer fully received' : 'Partial receipt recorded', data: transfer };
  }

  /** POST api/inventory/:storeId/transfer/:transferId/cancel — only while
   *  still `in_transit` (not yet partially/fully received) — the shipped
   *  quantity goes straight back to the source location, since it never
   *  actually left the seller's own hands from a data-integrity standpoint. */
  async cancelTransfer(sellerId: string, storeId: string, transferId: string) {
    const { storeModel, productVariantModel, variantLocationStockModel, stockTransferModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const transfer = await stockTransferModel.findOne({ _id: transferId, storeId });
    if (!transfer) throw new NotFoundException('Transfer not found');
    if (transfer.status !== 'in_transit') {
      throw new BadRequestException(`Only a fully in-transit transfer can be cancelled (this one is "${transfer.status}")`);
    }

    await variantLocationStockModel.updateOne(
      { variantId: transfer.variantId, locationId: transfer.fromLocationId },
      { $inc: { stock: transfer.quantity } },
    );
    await productVariantModel.updateOne(
      { _id: transfer.variantId },
      [{ $set: { inTransitStock: { $max: [0, { $subtract: ['$inTransitStock', transfer.quantity] }] } } }],
      { updatePipeline: true } as any,
    );

    transfer.status = 'cancelled';
    transfer.cancelledAt = new Date();
    await transfer.save();

    return { success: true, message: 'Transfer cancelled — stock returned to the source location', data: transfer };
  }

  /** GET api/inventory/:storeId/transfers — in-transit + recent transfer
   *  history, so a seller can see everything currently "on a truck" without
   *  drilling into each individual SKU. */
  async listTransfers(sellerId: string, storeId: string, query: any) {
    const { storeModel, stockTransferModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const filter: any = { storeId };
    if (query.status && query.status !== 'all') filter.status = query.status;

    const transfers = await stockTransferModel.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return { success: true, data: transfers };
  }

  /** GET api/inventory/:storeId/reorder-suggestions — every SKU at/below
   *  its reorder point, grouped by whichever supplier it was most recently
   *  RECEIVED from (via Purchase Order history) so a seller can generate
   *  one PO per supplier covering all of that supplier's low SKUs at once,
   *  instead of one PO per SKU (the real Shopify/Zoho replenishment
   *  pattern — see PurchaseOrdersController). A SKU never received via a PO
   *  yet groups under "No supplier yet".
   *
   *  `daysOfStockLeft` is now a real HYBRID forecast, not a flat average:
   *  for a SKU with enough sales history, `forecastDailyDemand()`
   *  (`demand-forecast.util.ts`) computes a trend+seasonality-aware
   *  forecast (Holt's linear exponential smoothing + a day-of-week
   *  multiplier) off its last 90 days of daily sales; for a SKU without
   *  enough history (a new product/store), it falls back to the original
   *  velocity estimate (units sold in the last 30 days ÷ 30) — every
   *  seller always gets an honest number, regardless of how much sales
   *  data they have. `forecastMethod` on each item discloses which one was
   *  actually used, so the UI never claims a "smart" prediction it didn't
   *  have enough data to make. */
  async getReorderSuggestions(sellerId: string, storeId: string) {
    const { storeModel, productModel, productVariantModel, purchaseOrderModel, orderModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const lowStockThreshold = store.lowStockThreshold ?? 10;

    const products = await productModel
      .find({ storeId, sellerId, isDelete: false, type: { $ne: 'digital' } })
      .select('name images')
      .lean();
    const productIds = products.map((p: any) => p._id.toString());
    const productById = new Map<string, any>(products.map((p: any) => [p._id.toString(), p]));

    const variants = productIds.length
      ? await productVariantModel.find({ productId: { $in: productIds }, isDelete: false, unlimitedStock: { $ne: true } }).lean()
      : [];

    const lowVariants = variants.filter((v: any) => {
      const available = Math.max(0, (v.stock || 0) - (v.committedStock || 0) - (v.damagedStock || 0) - (v.inTransitStock || 0));
      const threshold = v.reorderPoint ?? lowStockThreshold;
      return available <= threshold;
    });
    if (lowVariants.length === 0) return { success: true, data: { groups: [] } };
    const variantIds = lowVariants.map((v: any) => v._id.toString());

    const [recentPoItems, dailySales] = await Promise.all([
      purchaseOrderModel.aggregate([
        { $match: { storeId, status: { $in: ['received', 'partially_received'] } } },
        { $sort: { receivedAt: -1 } },
        { $unwind: '$items' },
        { $match: { 'items.variantId': { $in: variantIds } } },
        { $group: { _id: '$items.variantId', supplierId: { $first: '$supplierId' }, supplierName: { $first: '$supplierName' } } },
      ]),
      orderModel.aggregate([
        { $match: { isDelete: false, createdAt: { $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.storeId': storeId } },
        { $unwind: '$sellerOrders.items' },
        { $match: { 'sellerOrders.items.variantId': { $in: variantIds }, 'sellerOrders.items.status': { $ne: 'cancelled' } } },
        {
          $group: {
            _id: { variantId: '$sellerOrders.items.variantId', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
            qty: { $sum: '$sellerOrders.items.quantity' },
          },
        },
      ]),
    ]);
    const supplierByVariant = new Map(recentPoItems.map((r: any) => [r._id, { supplierId: r.supplierId, supplierName: r.supplierName }]));

    // Per-variant daily-quantity maps (for the forecast) + a plain 30-day
    // sum (for the fallback average) — both derived from the same 90-day
    // fetch, no second query needed.
    const dailyByVariant = new Map<string, Map<string, number>>();
    const thirtyDayCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const thirtyDaySumByVariant = new Map<string, number>();
    for (const row of dailySales as any[]) {
      const variantId = row._id.variantId;
      const day: string = row._id.day;
      if (!dailyByVariant.has(variantId)) dailyByVariant.set(variantId, new Map());
      dailyByVariant.get(variantId)!.set(day, row.qty);
      if (day >= thirtyDayCutoff) {
        thirtyDaySumByVariant.set(variantId, (thirtyDaySumByVariant.get(variantId) ?? 0) + row.qty);
      }
    }

    const groups = new Map<string, { supplierId: string | null; supplierName: string; items: any[] }>();
    for (const v of lowVariants as any[]) {
      const product = productById.get(v.productId);
      const supplier = supplierByVariant.get(v._id.toString());
      const key = supplier?.supplierId ?? 'unassigned';
      if (!groups.has(key)) {
        groups.set(key, { supplierId: supplier?.supplierId ?? null, supplierName: supplier?.supplierName ?? 'No supplier yet', items: [] });
      }
      const available = Math.max(0, (v.stock || 0) - (v.committedStock || 0) - (v.damagedStock || 0) - (v.inTransitStock || 0));
      const variantId = v._id.toString();
      const forecast = forecastDailyDemand(dailyByVariant.get(variantId) ?? new Map());
      const simpleAvg = (thirtyDaySumByVariant.get(variantId) ?? 0) / 30;
      const perDay = forecast ?? simpleAvg;
      groups.get(key)!.items.push({
        productId: v.productId, variantId,
        productName: product?.name ?? '(deleted product)', image: product?.images?.[0] ?? null,
        sku: v.sku, available, reorderPoint: v.reorderPoint ?? lowStockThreshold,
        daysOfStockLeft: perDay > 0 ? Math.round(available / perDay) : null,
        forecastMethod: forecast != null ? 'trend_seasonal' : 'simple_average',
      });
    }

    return { success: true, data: { groups: Array.from(groups.values()) } };
  }

  /** GET api/inventory/:storeId/valuation — real inventory-value + dead-
   *  stock + top-movers reporting. For a `trackLots` variant, total value
   *  uses the REAL FIFO figure — `Σ lot.quantityRemaining × lot.costPrice`
   *  across its still-active lots — genuine accounting-grade valuation, not
   *  a blended average. Every other SKU still uses `stock × costPrice`
   *  (weighted-average), only summed when `costPrice` is actually set (via
   *  Purchase Order receiving or the Inventory page's "Reorder point &
   *  cost" action) — never assumes 0 for a SKU with no recorded cost,
   *  which would understate value rather than honestly reporting it as
   *  unknown. "Dead stock" = real on-hand units with zero sales in the last
   *  90 days — a disclosed variant-level approximation (no per-lot aging in
   *  THIS list, even for a lot-tracked SKU — the total VALUE above is real
   *  FIFO, but per-lot expiry-aware dead-stock aging is a further,
   *  deliberately out-of-scope refinement). */
  async getValuation(sellerId: string, storeId: string) {
    const { storeModel, productModel, productVariantModel, orderModel, stockLotModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const products = await productModel
      .find({ storeId, sellerId, isDelete: false, type: { $ne: 'digital' } })
      .select('name')
      .lean();
    const productIds = products.map((p: any) => p._id.toString());
    const productById = new Map<string, any>(products.map((p: any) => [p._id.toString(), p]));
    const variants = productIds.length
      ? await productVariantModel.find({ productId: { $in: productIds }, isDelete: false, unlimitedStock: { $ne: true } }).lean()
      : [];

    const lotTrackedVariantIds = (variants as any[]).filter((v) => v.trackLots).map((v) => v._id.toString());
    const lotValueByVariant = new Map<string, number>();
    if (lotTrackedVariantIds.length > 0) {
      const lotTotals = await stockLotModel.aggregate([
        { $match: { variantId: { $in: lotTrackedVariantIds }, status: 'active', quantityRemaining: { $gt: 0 } } },
        { $group: { _id: '$variantId', value: { $sum: { $multiply: ['$quantityRemaining', '$costPrice'] } } } },
      ]);
      for (const t of lotTotals) lotValueByVariant.set(t._id, t.value);
    }

    let totalValue = 0;
    let valuedSkuCount = 0;
    for (const v of variants as any[]) {
      if (v.trackLots) {
        // Only "valued" if it actually has at least one active lot — a
        // freshly lot-enabled SKU with no receipts yet has no lots to sum.
        if (lotValueByVariant.has(v._id.toString())) { totalValue += lotValueByVariant.get(v._id.toString())!; valuedSkuCount++; }
      } else if (v.costPrice != null) {
        totalValue += (v.stock || 0) * v.costPrice; valuedSkuCount++;
      }
    }

    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const sales90 = await orderModel.aggregate([
      { $match: { isDelete: false, createdAt: { $gte: since90 } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId } },
      { $unwind: '$sellerOrders.items' },
      { $match: { 'sellerOrders.items.status': { $ne: 'cancelled' } } },
      { $group: { _id: '$sellerOrders.items.variantId', qty: { $sum: '$sellerOrders.items.quantity' } } },
    ]);
    const soldVariantIds90 = new Set(sales90.map((s: any) => s._id));

    const deadStock = (variants as any[])
      .filter(v => (v.stock || 0) > 0 && !soldVariantIds90.has(v._id.toString()))
      .map(v => ({
        productId: v.productId, variantId: v._id.toString(),
        productName: productById.get(v.productId)?.name ?? '(deleted product)', sku: v.sku,
        stock: v.stock, value: v.costPrice != null ? Math.round(v.stock * v.costPrice * 100) / 100 : null,
      }))
      .sort((a, b) => b.stock - a.stock)
      .slice(0, 50);

    const variantById = new Map((variants as any[]).map(v => [v._id.toString(), v]));
    const topMovers = [...sales90]
      .sort((a: any, b: any) => b.qty - a.qty)
      .slice(0, 10)
      .map((s: any) => {
        const v = variantById.get(s._id);
        if (!v) return null;
        return { variantId: s._id, productName: productById.get(v.productId)?.name ?? '(deleted product)', sku: v.sku, qty: s.qty };
      })
      .filter(Boolean);

    return {
      success: true,
      data: {
        totalValue: Math.round(totalValue * 100) / 100,
        valuedSkuCount, totalSkuCount: variants.length,
        deadStock, topMovers,
      },
    };
  }

  /** Real FIFO/FEFO lot consumption — same logic/contract as OrdersService's
   *  identically-named private helper (kept as a small, deliberate
   *  duplication rather than a shared cross-module abstraction for two
   *  call sites — see this pass's own "no premature abstraction"
   *  convention). Drains the oldest active lot(s) first; returns the real
   *  consumed cost, or does nothing (returns null) if no lots exist yet. */
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

  /** Called once daily by SchedulerService (`runLocked`) — the real emitter
   *  `NOTIFICATION_TYPES.LOW_STOCK` never had (it existed in
   *  `notification.types.ts` but nothing ever called `notify()` with it).
   *  One DIGEST notification per store ("N products are running low"), not
   *  one per SKU — a store with 40 low-stock SKUs shouldn't flood its own
   *  notification bell. Redis-deduped per store+day so re-running this
   *  (or a retry) never double-sends the same day's digest. */
  async sendLowStockDigests(): Promise<void> {
    const { productVariantModel } = this.databaseService.repositories;

    const pipeline: any[] = [
      { $match: { isDelete: false, unlimitedStock: { $ne: true } } },
      { $addFields: { productObjId: { $toObjectId: '$productId' } } },
      { $lookup: { from: 'products', localField: 'productObjId', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $match: { 'product.isDelete': false, 'product.status': 'active', 'product.type': { $ne: 'digital' } } },
      { $addFields: { storeObjId: { $toObjectId: '$product.storeId' } } },
      { $lookup: { from: 'stores', localField: 'storeObjId', foreignField: '_id', as: 'store' } },
      { $unwind: '$store' },
      { $match: { 'store.isDelete': false, 'store.status': 'active' } },
      {
        $addFields: {
          available: {
            $max: [0, {
              $subtract: [
                { $subtract: [{ $subtract: ['$stock', { $ifNull: ['$committedStock', 0] }] }, { $ifNull: ['$damagedStock', 0] }] },
                { $ifNull: ['$inTransitStock', 0] },
              ],
            }],
          },
          threshold: { $ifNull: ['$reorderPoint', { $ifNull: ['$store.lowStockThreshold', 10] }] },
        },
      },
      { $match: { $expr: { $lte: ['$available', '$threshold'] } } },
      { $group: { _id: '$product.storeId', sellerId: { $first: '$store.sellerId' }, count: { $sum: 1 } } },
    ];

    const groups = await productVariantModel.aggregate(pipeline);
    const today = new Date().toISOString().slice(0, 10);

    for (const g of groups) {
      if (!g.count) continue;
      const storeId = g._id as string;
      const dedupeKey = `low-stock-notified:${storeId}:${today}`;
      try {
        const already = await this.redis.get(dedupeKey);
        if (already) continue;
      } catch {
        // Redis unavailable — fail open and send anyway rather than silently skip forever.
      }

      await this.notificationsService.notify({
        recipientId: g.sellerId, recipientRole: 'seller', storeId,
        type: NOTIFICATION_TYPES.LOW_STOCK,
        title: 'Stock running low',
        body: `${g.count} product${g.count !== 1 ? 's are' : ' is'} running low on stock.`,
        data: { count: g.count, link: `/store/${storeId}/inventory?status=low_stock` },
      });

      try {
        await this.redis.set(dedupeKey, '1', 25 * 60 * 60); // 25h — comfortably covers one calendar day even with cron drift
      } catch {
        // Best-effort only — a missed dedupe write just risks one extra digest tomorrow, not a correctness bug.
      }
    }
  }
}
