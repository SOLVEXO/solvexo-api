/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEnum, IsNumber, IsOptional, IsDateString, IsBoolean, IsInt, Min } from 'class-validator';
import { IsMongoId } from 'class-validator';

export class UpdateCouponDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ required: false, enum: ['percentage', 'fixed'] })
  @IsOptional()
  @IsEnum(['percentage', 'fixed'])
  discountType?: 'percentage' | 'fixed';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountValue?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number | null;

  @ApiProperty({ required: false, description: 'G2.4: honour this coupon at the POS till' })
  @IsOptional()
  @IsBoolean()
  posEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  usageLimit?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQuantity?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  oncePerCustomer?: boolean;

  @ApiProperty({ required: false, description: 'Saved customer segment id — only its members can redeem (null = everyone)' })
  @IsOptional()
  @IsMongoId()
  customerSegmentId?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
