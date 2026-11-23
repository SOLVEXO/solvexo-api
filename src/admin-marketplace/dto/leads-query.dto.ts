import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { VERIFICATION_STATUSES, SellerType, ProductType } from '../../store/schemas/store.schema';

export class LeadsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, enum: [...VERIFICATION_STATUSES, 'all'], description: 'Omit for the default pending/under_review review queue; "all" removes the status filter entirely.' })
  @IsOptional()
  @IsIn([...VERIFICATION_STATUSES, 'all'])
  verificationStatus?: string;

  @ApiProperty({ required: false, enum: Object.values(SellerType), description: 'Only stores whose seller chose this type in onboarding / Settings.' })
  @IsOptional()
  @IsIn(Object.values(SellerType))
  sellerType?: string;

  @ApiProperty({ required: false, enum: Object.values(ProductType), description: 'Only stores that sell this category (productTypes contains it).' })
  @IsOptional()
  @IsIn(Object.values(ProductType))
  productType?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
