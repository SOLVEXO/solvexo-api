/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean,
  IsArray, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PlatformPlanLimitsDto } from './platform-plan-limits.dto';

export class CreatePlatformPlanDto {
  @ApiProperty({ example: 'Professional' })
  @IsString() @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  description?: string;

  @ApiProperty({ required: false, example: 'Popular' })
  @IsOptional() @IsString()
  badge?: string;

  @ApiProperty({ required: false, default: 0 })
  @IsOptional() @Type(() => Number) @IsNumber()
  sortOrder?: number;

  @ApiProperty({ required: false, default: true, description: 'Show this plan on the public pricing page. Set false for a negotiated/legacy plan an admin still wants assignable but not self-serve.' })
  @IsOptional() @IsBoolean()
  isPubliclyVisible?: boolean;

  @ApiProperty({ required: false, default: false })
  @IsOptional() @IsBoolean()
  isFree?: boolean;

  @ApiProperty({ required: false, default: false, description: 'Enterprise-style "Contact Sales" — no self-serve checkout' })
  @IsOptional() @IsBoolean()
  isCustomPricing?: boolean;

  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  monthlyPriceUSD?: number;

  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  yearlyPriceUSD?: number;

  @ApiProperty({ required: false, default: 0, deprecated: true, description: 'No longer read anywhere — trial duration is now the platform-wide PlatformTrialSettings.durationDays, not per-plan.' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  trialDays?: number;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  featureBullets?: string[];

  @ApiProperty({ required: false, default: false, description: 'Shopify-style "$1/mo for 3 months, then full price" — monthly billing only.' })
  @IsOptional() @IsBoolean()
  introOfferEnabled?: boolean;

  @ApiProperty({ required: false, description: 'The discounted monthly price during the intro period — required if introOfferEnabled.' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  introPriceUSD?: number;

  @ApiProperty({ required: false, description: 'Whole months the intro price lasts before reverting to monthlyPriceUSD — required if introOfferEnabled.' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  introDurationCycles?: number;

  @ApiProperty({ type: PlatformPlanLimitsDto })
  @ValidateNested()
  @Type(() => PlatformPlanLimitsDto)
  limits: PlatformPlanLimitsDto;
}
