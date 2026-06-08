
import { IsOptional, IsString, IsNumber } from 'class-validator';

export class AddToCartDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  productVariantId?: string;

    @IsOptional()
  @IsNumber()
  quantity?: number;

}