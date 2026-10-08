import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateCartQuantityDto {
  @IsNotEmpty()
  @IsString()
  storeId: string;

  @IsNotEmpty()
  @IsString()
  productId: string;

  @IsNotEmpty()
  @IsString()
  productVariantId: string;

  @IsOptional()
  @IsIn(['increase', 'decrease'])
  action?: 'increase' | 'decrease';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  quantity?: number;
}
