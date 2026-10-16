import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Shopify-style market price rule. Every field is optional; missing = automatic FX, no adjustment. */
export class MarketPricingRuleDto {
  /** auto = live exchange rate; manual = the seller's own fixed exchange rate (`manualRate`). `percentage` and
   *  `fixed` are kept for markets saved before this split and behave like `auto` (fixed per-product prices always
   *  win when a product has one, whatever the type). */
  @IsOptional()
  @IsIn(['auto', 'manual', 'percentage', 'fixed'])
  type?: 'auto' | 'manual' | 'percentage' | 'fixed';

  /** 1 unit of the store currency = `manualRate` units of the market currency (only for type `manual`). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  @Max(1_000_000)
  manualRate?: number | null;

  /** Price adjustment for the whole market, e.g. 10 = +10 %, -5 = -5 %. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-90)
  @Max(500)
  percentageAdjustment?: number | null;

  @IsOptional()
  @IsBoolean()
  useRounding?: boolean;

  @IsOptional()
  @IsIn(['0.95', '0.99', '1.00', 'nearest'])
  roundingRule?: '0.95' | '0.99' | '1.00' | 'nearest';

  /** Extra % the seller adds on converted prices (kept for markets saved earlier). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  conversionFee?: number | null;
}

export class MarketShippingSettingsDto {
  @IsOptional()
  @IsIn(['store', 'local'])
  currencyMode?: 'store' | 'local';
}

export class CreateMarketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  /** ISO 3166-1 alpha-2 codes. Empty only for the primary market (= every country no other market lists). */
  @IsArray()
  @ArrayMaxSize(250)
  @Matches(/^[A-Za-z]{2}$/, { each: true, message: 'Each country must be a 2-letter country code' })
  countries: string[];

  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: 'Currency must be a 3-letter currency code' })
  currency: string;

  /** Language codes such as `en`, `ur`, `fr-CA`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/, { each: true, message: 'Each language must be a language code like en or fr-CA' })
  languages?: string[];

  @IsOptional()
  @IsEnum(['primary', 'subdomain', 'subfolder'])
  domainType?: 'primary' | 'subdomain' | 'subfolder';

  @IsOptional()
  @IsString()
  @MaxLength(253)
  domain?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  subfolder?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => MarketPricingRuleDto)
  pricingRule?: MarketPricingRuleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => MarketShippingSettingsDto)
  shippingSettings?: MarketShippingSettingsDto;

  /** Shopify catalog availability: all products, only `productIds`, or all except `productIds`. */
  @IsOptional()
  @IsIn(['all', 'include', 'exclude'])
  productAvailability?: 'all' | 'include' | 'exclude';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @Matches(/^[a-f0-9]{24}$/i, { each: true, message: 'Invalid product id' })
  productIds?: string[];
}
