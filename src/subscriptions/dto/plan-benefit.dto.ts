/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum, IsOptional, IsBoolean, IsString, IsArray, IsNumber, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export const BENEFIT_TYPES = [
  'discount', 'shipping', 'early_access', 'loyalty_multiplier', 'credits',
  'priority_support', 'priority_booking',
] as const;
export type BenefitType = (typeof BENEFIT_TYPES)[number];

// One flat DTO covering every benefit type's optional config — same pattern
// as AddPayoutMethodDto (finance module), which mixes bank/paypal/stripe
// fields in a single shape rather than a discriminated union.
export class PlanBenefitDto {
  @ApiProperty({ enum: BENEFIT_TYPES })
  @IsEnum(BENEFIT_TYPES)
  type: BenefitType;

  @ApiProperty({ required: false, default: true })
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, description: 'Custom marketing label shown to buyers' })
  @IsOptional() @IsString()
  label?: string;

  // ── discount ──────────────────────────────────────────────────────────────
  @ApiProperty({ required: false, enum: ['store', 'category', 'product'] })
  @IsOptional() @IsEnum(['store', 'category', 'product'])
  scope?: 'store' | 'category' | 'product';

  @ApiProperty({ required: false, type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  categoryIds?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  productIds?: string[];

  @ApiProperty({ required: false, description: '1-50%, platform-capped' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(50)
  discountPercent?: number;

  @ApiProperty({ required: false, description: 'Caps the $ amount of a single discount, regardless of percent' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  maxDiscountAmountUSD?: number;

  @ApiProperty({ required: false, description: 'Minimum order value required to use this discount (checked at checkout)' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  minOrderValueUSD?: number;

  // ── shipping ──────────────────────────────────────────────────────────────
  @ApiProperty({ required: false, enum: ['free', 'discounted'] })
  @IsOptional() @IsEnum(['free', 'discounted'])
  shippingType?: 'free' | 'discounted';

  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(100)
  shippingDiscountPercent?: number;

  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  minOrderValueForShippingUSD?: number;

  // ── early access ──────────────────────────────────────────────────────────
  @ApiProperty({ required: false, description: 'Hours new products are featured to members before general promotion' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(720)
  earlyAccessHours?: number;

  // ── loyalty multiplier ────────────────────────────────────────────────────
  @ApiProperty({ required: false, description: 'Points multiplier, e.g. 2 = 2x points while subscribed' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(5)
  multiplier?: number;

  // ── credits (digital/service) ─────────────────────────────────────────────
  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  creditsPerCycle?: number;

  @ApiProperty({ required: false, enum: ['download', 'service'] })
  @IsOptional() @IsEnum(['download', 'service'])
  creditType?: 'download' | 'service';
}
