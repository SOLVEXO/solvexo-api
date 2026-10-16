import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type MarketPriceDocument = MarketPrice & Document;

/**
 * Market-specific pricing for products and variants.
 * Allows sellers to set fixed prices or percentage adjustments
 * per market, instead of relying only on automatic FX conversion.
 */
@Schema({ timestamps: true })
export class MarketPrice {
  /** Owning store (rows written before this field existed have null and are matched by marketId). */
  @Prop({ type: String, default: null, index: true })
  storeId: string | null;

  @Prop({ required: true, index: true })
  marketId: string;

  @Prop({ required: true, index: true })
  productId: string;

  /**
   * Variant ID if this price is for a specific variant.
   * Null if this price applies to the base product (default variant).
   */
  @Prop({ type: String, index: true, default: null })
  variantId: string | null;

  /**
   * Pricing type:
   * - percentage: Apply percentage adjustment to base price
   * - fixed: Use this exact price (overrides base price + FX)
   */
  @Prop({ type: String, enum: ['percentage', 'fixed'], required: true })
  priceType: 'percentage' | 'fixed';

  /**
   * Percentage adjustment (e.g., 10 for +10%, -5 for -5%).
   * Only used when priceType = 'percentage'.
   */
  @Prop({ type: Number, default: null })
  percentageAdjustment: number | null;

  /**
   * Fixed price in the market's currency.
   * Only used when priceType = 'fixed'.
   */
  @Prop({ type: Number, default: null })
  fixedPrice: number | null;

  /**
   * Currency of this price (must match market currency).
   */
  @Prop({ required: true })
  currency: string;

  /**
   * Compare-at price for showing strikethrough pricing.
   * In the market's currency.
   */
  @Prop({ type: Number, default: null })
  compareAtPrice: number | null;

  @Prop({ default: false })
  isDelete: boolean;
}

export const MarketPriceSchema = SchemaFactory.createForClass(MarketPrice);

// Compound index for unique market pricing per product/variant
MarketPriceSchema.index({ marketId: 1, productId: 1, variantId: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
