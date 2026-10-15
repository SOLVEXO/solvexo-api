import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsNumber, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateMarketPriceDto {
  @ApiProperty({ description: 'Market ID' })
  @IsString()
  @IsNotEmpty()
  marketId: string;

  @ApiProperty({ description: 'Product ID' })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ description: 'Variant ID (optional, for specific variant pricing)', required: false })
  @IsString()
  @IsOptional()
  variantId?: string | null;

  @ApiProperty({ description: 'Pricing type: percentage or fixed', enum: ['percentage', 'fixed'] })
  @IsEnum(['percentage', 'fixed'])
  @IsNotEmpty()
  priceType: 'percentage' | 'fixed';

  @ApiProperty({ description: 'Percentage adjustment (e.g., 10 for +10%, -5 for -5%)', required: false })
  @IsNumber()
  @IsOptional()
  percentageAdjustment?: number | null;

  @ApiProperty({ description: 'Fixed price in market currency', required: false })
  @IsNumber()
  @IsOptional()
  fixedPrice?: number | null;

  @ApiProperty({ description: 'Currency of the price' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({ description: 'Compare-at price for strikethrough display', required: false })
  @IsNumber()
  @IsOptional()
  compareAtPrice?: number | null;
}
