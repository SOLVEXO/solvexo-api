import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type MarketDocument = Market & Document;

/**
 * A field of this sub-document is literally called `type` (auto/percentage/...), which Mongoose would read as the
 * schema type keyword and refuse to build the model (the whole app then fails to boot). `typeKey: '$type'` frees the word.
 */
const PricingRuleSchema = new MongooseSchema(
  {
    type: { $type: String, enum: ['auto', 'manual', 'percentage', 'fixed'], default: 'auto' },
    manualRate: { $type: Number, default: null },
    percentageAdjustment: { $type: Number, default: null },
    useRounding: { $type: Boolean, default: false },
    roundingRule: { $type: String, enum: ['0.95', '0.99', '1.00', 'nearest'], default: 'nearest' },
    conversionFee: { $type: Number, default: null },
  },
  { _id: false, typeKey: '$type' },
);

/**
 * A Market represents a country/region or language-based market for a store.
 * Unlike the simple currency list in Store.enabledCurrencies, this model
 * supports the full Shopify Markets architecture: countries, currencies,
 * languages, domains, and pricing rules.
 */
@Schema({ timestamps: true })
export class Market {
  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true })
  name: string;

  /**
   * Countries/regions in this market. Empty = domestic market.
   * ISO 3166-1 alpha-2 codes (e.g., 'US', 'GB', 'DE').
   */
  @Prop({ type: [String], default: [] })
  countries: string[];

  /**
   * The currency buyers pay in on this market.
   * Must be one of the platform's enabled currencies.
   */
  @Prop({ required: true })
  currency: string;

  /**
   * Languages available in this market.
   * Empty = no language restriction (uses default store language).
   * ISO 639-1 codes (e.g., 'en', 'ur', 'fr').
   */
  @Prop({ type: [String], default: [] })
  languages: string[];

  /**
   * Domain configuration for this market.
   * primary = no custom domain (uses subdomain.solvexo.store)
   * subdomain = custom subdomain (e.g., eu.store.com)
   * subfolder = URL subfolder (e.g., /en-ca/)
   */
  @Prop({ type: String, enum: ['primary', 'subdomain', 'subfolder'], default: 'primary' })
  domainType: 'primary' | 'subdomain' | 'subfolder';

  /**
   * Custom domain for this market (if domainType != 'primary').
   * e.g., 'eu.mystore.com' for subdomain, null for subfolder.
   */
  @Prop({ type: String, default: null })
  domain: string | null;

  /**
   * Subfolder for this market (if domainType == 'subfolder').
   * e.g., 'en-ca' for /en-ca/ URLs.
   */
  @Prop({ type: String, default: null })
  subfolder: string | null;

  /**
   * Whether this market is active.
   * Inactive markets cannot be used for checkout.
   */
  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  /**
   * Whether this is the primary market (domestic market).
   * Exactly one market per store should be primary.
   */
  @Prop({ type: Boolean, default: false })
  isPrimary: boolean;

  /**
   * Pricing rules for this market.
   */
  @Prop({ type: PricingRuleSchema, default: () => ({ type: 'auto' as const }) })
  pricingRule: {
    type: 'auto' | 'manual' | 'percentage' | 'fixed';
    manualRate?: number | null;
    percentageAdjustment?: number;
    useRounding?: boolean;
    roundingRule?: '0.95' | '0.99' | '1.00' | 'nearest';
    conversionFee?: number;
  };

  /**
   * Shipping settings for this market.
   */
  @Prop({
    type: {
      currencyMode: { type: String, enum: ['store', 'local'], default: 'store' },
    },
    default: () => ({ currencyMode: 'store' as const }),
  })
  shippingSettings: {
    currencyMode: 'store' | 'local';
  };

  /**
   * Shopify catalog availability for this market: every product, only `productIds`, or every product except
   * `productIds`. Enforced on the storefront product lists and at checkout.
   */
  @Prop({ type: String, enum: ['all', 'include', 'exclude'], default: 'all' })
  productAvailability: 'all' | 'include' | 'exclude';

  @Prop({ type: [String], default: [] })
  productIds: string[];

  @Prop({ default: false })
  isDelete: boolean;
}

export const MarketSchema = SchemaFactory.createForClass(Market);
MarketSchema.index({ storeId: 1, isDelete: 1, isActive: 1 });
