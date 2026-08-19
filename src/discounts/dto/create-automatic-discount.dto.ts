/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, IsDateString, IsArray, Min } from 'class-validator';

export class CreateAutomaticDiscountDto {
  @ApiProperty({ example: 'Summer Sale' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ enum: ['percentage', 'fixed'] })
  @IsEnum(['percentage', 'fixed'])
  discountType: 'percentage' | 'fixed';

  @ApiProperty({ example: 15 })
  @IsNumber()
  @Min(0)
  discountValue: number;

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
