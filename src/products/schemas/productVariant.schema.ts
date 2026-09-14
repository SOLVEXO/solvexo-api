/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductVariantDocument = ProductVariant & Document;

@Schema({ timestamps: true })
export class ProductVariant {

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ required: true })
  sku: string;

  @Prop({ type: String, default: null })
  barcode: string | null;

  @Prop({ required: true })
  price: number;

  // Denominated in the owning Store's baseCurrency at the moment this
  // variant was created — stamped server-side by
  // ProductVariantsService/ProductsService, never client-supplied, and
  // immutable afterwards (a store's currency itself is locked once its
  // first product exists — see StoreService.createStore). Nullable at the
  // schema level only so pre-existing variants created before this field
  // existed remain readable/writable without a forced migration; the
  // one-time backfill sets them all to 'PKR' (see migration script —
  // Solvexo was Pakistan-only until this field was introduced, so this is a
  // label, never a numeric reinterpretation of `price`).
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: Number, default: null })
  compareAtPrice!: number | null;

  // physical only — arbitrary seller-defined attributes (Color, Size,
  // Material, etc). Every active (isDelete:false) variant on a given
  // product must use the same set of attribute names — enforced in
  // ProductVariantsService/ProductsService, not at the schema level.
  @Prop({ type: [{ name: String, value: String }], default: [] })
  options!: { name: string; value: string }[];

  @Prop({ default: 0 })
  stock: number;

  // Real-time "already reserved by a paid-but-not-yet-shipped order" pool —
  // added alongside the reserve-at-checkout / decrement-at-shipment model
  // (see PaymentService.createOrder and OrdersService.updateSellerOrderStatus).
  // `stock` itself only ever decreases once the seller marks an order
  // "shipped" — until then, the reserved quantity lives here instead, so
  // `stock` still reflects genuine on-hand inventory. Everywhere that needs
  // "can this still be sold right now" must read `stock - committedStock`
  // (the Inventory page's "Available" column), never raw `stock` alone.
  @Prop({ default: 0 })
  committedStock: number;

  // Units physically on-hand but NOT sellable — damaged-on-receipt (see
  // PurchaseOrdersService.receive), or a return marked "damaged" instead of
  // restocked (see RefundRequestService.approve). Kept as a real, visible
  // bucket rather than just deleting the units on a negative adjustment, so
  // a seller can later file a supplier-return claim or do an explicit
  // "write off" (its own audited action) instead of the loss being
  // untraceable. `available` = stock - committedStock - damagedStock.
  @Prop({ default: 0 })
  damagedStock: number;

  // Units shipped out of a source location but not yet received at their
  // destination (InventoryService.shipTransfer/receiveTransfer) — genuinely
  // owned, genuinely not sitting in any location's sellable row right now.
  // `stock` (the aggregate total) INCLUDES this — it's still real on-hand
  // inventory, just physically in transit — so the true invariant is
  // `stock = sum(VariantLocationStock rows for this variant) + inTransitStock`,
  // and `available = stock - committedStock - damagedStock - inTransitStock`.
  @Prop({ default: 0 })
  inTransitStock: number;

  // Per-SKU override of the store's single `lowStockThreshold` — null falls
  // back to the store-wide value (same nullable-override convention as
  // Store.enabledCurrencies). Lets a fast-moving SKU and a slow-moving one
  // each get a threshold that actually matches their own sell-through rate.
  @Prop({ type: Number, default: null })
  reorderPoint: number | null;

  // Weighted-average unit cost — recomputed on every Purchase Order receipt
  // (`newAvgCost = (existingQty*existingCost + receivedQty*unitCost) /
  // (existingQty+receivedQty)`), never simply overwritten with the latest
  // receipt's cost — a single "last cost" field would misstate valuation/
  // margin the moment two receipts at different prices exist. Also
  // manually editable (Edit Product) for a seller who never uses Purchase
  // Orders. Null until a cost is ever recorded — inventory valuation only
  // sums SKUs that actually have one, never assumes 0.
  @Prop({ type: Number, default: null })
  costPrice: number | null;

  // physical only — when true, `stock` is ignored everywhere (cart, checkout,
  // payment, POS, inventory dashboard) and the product is always purchasable.
  @Prop({ default: false })
  unlimitedStock: boolean;

  @Prop({ type: String, default: null })
  shippingWeight!: string | null;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ default: false })
  isDefault!: boolean;

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status!: string;

  @Prop({ default: false })
  isDelete!: boolean;
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant);

ProductVariantSchema.index({ productId: 1 });
ProductVariantSchema.index({ sku: 1 });
ProductVariantSchema.index({ barcode: 1 }, { sparse: true });