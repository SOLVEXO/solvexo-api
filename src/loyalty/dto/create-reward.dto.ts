/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, Min } from 'class-validator';

export class CreateRewardDto {
  @ApiProperty({ example: 'Free Shipping Voucher' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 200 })
  @IsNumber()
  @Min(1)
  pointsCost: number;

  @ApiProperty({ enum: ['fixed_discount', 'free_product'] })
  @IsEnum(['fixed_discount', 'free_product'])
  type: 'fixed_discount' | 'free_product';

  @ApiProperty({ required: false, description: 'Required when type = fixed_discount' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountValue?: number;

  @ApiProperty({ required: false, description: 'Required when type = free_product' })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  stockLimit?: number;
}
