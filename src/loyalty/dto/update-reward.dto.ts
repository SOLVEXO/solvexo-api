/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsNumber, IsOptional, IsBoolean, Min } from 'class-validator';

export class UpdateRewardDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  pointsCost?: number;

  @ApiProperty({ required: false, enum: ['fixed_discount', 'free_product'] })
  @IsOptional()
  @IsEnum(['fixed_discount', 'free_product'])
  type?: 'fixed_discount' | 'free_product';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  discountValue?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  stockLimit?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
