/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, IsDateString, IsArray, Min } from 'class-validator';

export class CreateAutomaticDiscountDto {
  @ApiProperty({ example: 'Summer Sale' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ enum: ['percentage', 'fixed', 'bogo', 'free_shipping'] })
  @IsEnum(['percentage', 'fixed', 'bogo', 'free_shipping'])
  discountType: 'percentage' | 'fixed' | 'bogo' | 'free_shipping';

  @ApiProperty({ example: 15, description: 'Ignored for bogo/free_shipping — send 0.' })
  @IsNumber()
  @Min(0)
  discountValue: number;

  @ApiProperty({ required: false, example: 2, description: 'Required when discountType is bogo.' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  buyQuantity?: number;

  @ApiProperty({ required: false, example: 1, description: 'Required when discountType is bogo.' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  getQuantity?: number;

  @ApiProperty({ required: false, example: 100, description: '100 = the "get" units are free; a smaller value gives a partial discount on them instead.' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  getDiscountPercent?: number;

  @ApiProperty({ enum: ['store', 'category', 'products'] })
  @IsEnum(['store', 'category', 'products'])
  target: 'store' | 'category' | 'products';

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  @ApiProperty({ required: false, example: 50 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}
