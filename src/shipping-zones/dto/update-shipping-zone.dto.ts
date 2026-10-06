import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, Min, IsEnum, IsArray, ArrayMaxSize, ValidateNested, MaxLength, IsInt, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ShippingRateTierDto } from './create-shipping-zone.dto';

export class UpdateShippingZoneDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  province?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  shippingPrice?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  estimatedDeliveryTime?: string;

  @ApiProperty({ required: false, enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: 'active' | 'inactive';

  @ApiProperty({ required: false, enum: ['shipping', 'local_delivery', 'pickup'] })
  @IsOptional()
  @IsEnum(['shipping', 'local_delivery', 'pickup'])
  zoneType?: 'shipping' | 'local_delivery' | 'pickup';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiProperty({ required: false, enum: ['flat', 'weight', 'price'] })
  @IsOptional()
  @IsEnum(['flat', 'weight', 'price'])
  rateType?: 'flat' | 'weight' | 'price';

  @ApiProperty({ required: false, type: [ShippingRateTierDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ShippingRateTierDto)
  rateTiers?: ShippingRateTierDto[];

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  freeShippingThreshold?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  pickupAddress?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  pickupInstructions?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  minDays?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  maxDays?: number | null;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  postalCodes?: string[];

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  profileId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  regionName?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(500)
  radiusKm?: number | null;
}
