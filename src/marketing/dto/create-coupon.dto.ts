/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsNumber, IsOptional, IsDateString, IsBoolean, Min } from 'class-validator';
import { IsMongoId } from 'class-validator';

export class CreateCouponDto {
  @ApiProperty({ example: 'BACK2SCHOOL' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ enum: ['percentage', 'fixed'] })
  @IsEnum(['percentage', 'fixed'])
  discountType: 'percentage' | 'fixed';

  @ApiProperty({ example: 20 })
  @IsNumber()
  @Min(0)
  discountValue: number;

  @ApiProperty({ required: false, example: 50 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderAmount?: number;

  @ApiProperty({ required: false, description: 'G2.4: honour this coupon at the POS till (default false)' })
  @IsOptional()
  @IsBoolean()
  posEnabled?: boolean;

  @ApiProperty({ required: false, example: 100 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  usageLimit?: number;

  @ApiProperty({ required: false, description: 'Saved customer segment id — only its members can redeem (null = everyone)' })
  @IsOptional()
  @IsMongoId()
  customerSegmentId?: string | null;

  @ApiProperty({ required: false, example: '2026-05-01', description: 'Coupon is inactive until this date — omit to activate immediately.' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiProperty({ required: false, example: '2026-06-30' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
