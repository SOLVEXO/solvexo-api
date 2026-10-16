import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * A fixed price for one product (or one of its variants) in one market — Shopify catalog "fixed price".
 * The price is in the MARKET's currency and is used as-is (no FX, adjustment or rounding).
 */
export class SetMarketPriceDto {
  @ApiProperty({ description: 'Product ID' })
  @IsMongoId()
  productId: string;

  @ApiProperty({ description: 'Variant ID; omit for a price that applies to every variant of the product', required: false })
  @IsOptional()
  @IsMongoId()
  variantId?: string | null;

  @ApiProperty({ description: 'Fixed price in the market currency' })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100_000_000)
  fixedPrice: number;

  @ApiProperty({ description: 'Compare-at price in the market currency', required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100_000_000)
  compareAtPrice?: number | null;
}

/** Kept for older imports. */
export { SetMarketPriceDto as CreateMarketPriceDto };
