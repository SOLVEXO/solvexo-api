import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { toCsv } from '@/analytics/utils/csv.util';
import { STOCK_ADJUSTMENT_REASONS, type StockAdjustmentReason } from './schemas/stock-adjustment.schema';

@Injectable()
export class InventoryService {
  constructor(private readonly databaseService: DatabaseService) {}

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
          variants.reduce((sum: number, v: any) => sum + ((v.stock || 0) - (v.committedStock || 0)), 0),
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
          .select('productId stock committedStock unlimitedStock')
          .lean()
      : [];

    // Uses real AVAILABLE stock (stock - committed), not raw on-hand — a
    // product that's technically "5 in stock" but all 5 already promised
    // to pending orders genuinely has nothing left to sell right now, and
    // this alert exists specifically to warn about that (see
    // ProductVariant.committedStock / getStockLines' identical reasoning).
    const availableByProduct = new Map<string, number>();
    const unlimitedProducts = new Set<string>();
    for (const v of variants) {
      if ((v as any).unlimitedStock) {
        unlimitedProducts.add(v.productId);
        continue;
      }
      const available = Math.max(0, (v.stock || 0) - ((v as any).committedStock || 0));
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
   *  this one is Inventory's own, dedicated to actual stock management). */
  async getStockLines(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');
    const { productModel, productVariantModel, storeModel } = this.databaseService.repositories;

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    const lowStockThreshold = store.lowStockThreshold ?? 10;

    const products = await productModel
      .find({ storeId, sellerId, isDelete: false, type: { $ne: 'digital' } })
      .select('name images')
      .lean();
    const productById = new Map<string, any>(products.map((p: any) => [p._id.toString(), p]));
    const productIds = products.map((p: any) => p._id.toString());

    const variants = productIds.length
      ? await productVariantModel
          .find({ productId: { $in: productIds }, isDelete: false })
          .sort({ productId: 1, isDefault: -1 })
          .lean()
      : [];

    let lines = variants.map((v: any) => {
      const product = productById.get(v.productId);
      const committed = v.committedStock || 0;
      // "Available" (real sellable-right-now quantity) is what status/low-
      // stock logic reacts to — a variant can show real `stock` while every
      // last unit is already promised to a paid-but-unshipped order (see
      // ProductVariant.committedStock's doc comment).
      const available = Math.max(0, v.stock - committed);
      let status: 'in_stock' | 'low_stock' | 'out_of_stock' | 'unlimited' = 'in_stock';
      if (v.unlimitedStock) status = 'unlimited';
      else if (available === 0) status = 'out_of_stock';
      else if (available <= lowStockThreshold) status = 'low_stock';

      return {
        variantId: v._id.toString(),
        productId: v.productId,
        productName: product?.name ?? '(deleted product)',
        image: product?.images?.[0] ?? null,
        sku: v.sku,
        options: v.options ?? [],
        price: v.price,
        stock: v.stock,
        committedStock: committed,
        available,
        unlimitedStock: !!v.unlimitedStock,
        status,
      };
    });

    const search = (query.search ?? '').trim().toLowerCase();
    if (search) {
      lines = lines.filter(
        (l) => l.productName.toLowerCase().includes(search) || l.sku.toLowerCase().includes(search),
      );
    }

    const stats = {
      totalLines: lines.length,
      inStock: lines.filter((l) => l.status === 'in_stock' || l.status === 'unlimited').length,
      lowStock: lines.filter((l) => l.status === 'low_stock').length,
      outOfStock: lines.filter((l) => l.status === 'out_of_stock').length,
    };

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const total = lines.length;
    const paged = lines.slice((page - 1) * limit, page * limit);

    return {
      success: true,
      data: { stats, pagination: { page, limit, total }, lines: paged },
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
  async adjustStock(
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

      const allRows = await variantLocationStockModel.find({ variantId }).lean();
      newStock = allRows.reduce((sum, r: any) => sum + (r.stock || 0), 0);
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

    const seller = await sellerModel.findOne({ _id: sellerId }).select('name');

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
   *  first time a seller looks at it by location. */
  private async ensureLocationStockSeeded(storeId: string, variantId: string, variant: { productId: string; stock: number }) {
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

  /** GET api/inventory/:storeId/variant/:variantId/locations — real
   *  per-branch stock breakdown for one SKU. Only meaningful once the
   *  store has 2+ active locations — the frontend only shows this option
   *  in that case. */
  async getVariantLocations(sellerId: string, storeId: string, variantId: string) {
    const { storeModel, productVariantModel, variantLocationStockModel, storeLocationModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    const variant = await productVariantModel.findOne({ _id: variantId, isDelete: false });
    if (!variant) throw new NotFoundException('Variant not found');

    await this.ensureLocationStockSeeded(storeId, variantId, variant);

    const [locations, rows] = await Promise.all([
      storeLocationModel.find({ storeId, isDelete: false, status: 'active' }).sort({ createdAt: 1 }).lean(),
      variantLocationStockModel.find({ variantId }).lean(),
    ]);
    const stockByLocation = new Map(rows.map((r: any) => [r.locationId, r.stock]));

    return {
      success: true,
      data: {
        variantId,
        totalStock: variant.stock,
        locations: locations.map((l: any) => ({
          locationId: l._id.toString(),
          locationName: l.name,
          isDefault: !!l.isDefault,
          stock: stockByLocation.get(l._id.toString()) ?? 0,
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

  /** POST api/inventory/:storeId/variant/:variantId/transfer — real
   *  branch-to-branch stock move (Shopify's own "Transfer" equivalent).
   *  Always net-zero on the variant's total `stock` — only the two
   *  location rows change — so this never touches ProductVariant.stock. */
  async transferStock(
    sellerId: string,
    storeId: string,
    variantId: string,
    fromLocationId: string,
    toLocationId: string,
    quantity: number,
    note?: string,
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
    await variantLocationStockModel.updateOne(
      { variantId, locationId: toLocationId },
      { $inc: { stock: quantity }, $setOnInsert: { storeId, productId: variant.productId } },
      { upsert: true },
    );

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
      note: note?.trim() || null,
      transferredBy: sellerId,
      transferredByName: seller?.name ?? null,
    });

    return { success: true, message: 'Stock transferred successfully', data: transfer };
  }
}
