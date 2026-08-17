/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class FestivalPricingOverrideDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty() @IsDateString() startAt: string;
  @ApiProperty() @IsDateString() endAt: string;
  @ApiProperty({ example: 49.99 }) @IsNumber() @Min(0) rate: number;
}

export class PlacementRateCardDto {
  @ApiProperty({ required: false, example: 5 }) @IsOptional() @IsNumber() @Min(0) hourly?: number;
  @ApiProperty({ required: false, example: 25 }) @IsOptional() @IsNumber() @Min(0) daily?: number;
  @ApiProperty({ required: false, example: 140 }) @IsOptional() @IsNumber() @Min(0) weekly?: number;
  @ApiProperty({ required: false, example: 450 }) @IsOptional() @IsNumber() @Min(0) monthly?: number;
  @ApiProperty({ required: false, example: 1.25 }) @IsOptional() @IsNumber() @Min(0) weekendMultiplier?: number;
  @ApiProperty({ required: false, example: 1.5 }) @IsOptional() @IsNumber() @Min(0) peakMultiplier?: number;
  @ApiProperty({ required: false, type: [FestivalPricingOverrideDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FestivalPricingOverrideDto)
  festivalOverrides?: FestivalPricingOverrideDto[];
}

/** One rate card per placement — placements are the same fixed set as `PROMOTION_PLACEMENTS`. */
export class UpdatePromotionPricingDto {
  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  homepageHero?: PlacementRateCardDto;

  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  marketplaceHero?: PlacementRateCardDto;

  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  educationHero?: PlacementRateCardDto;

  @ApiProperty({ required: false, type: PlacementRateCardDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PlacementRateCardDto)
  categoryHero?: PlacementRateCardDto;
}
