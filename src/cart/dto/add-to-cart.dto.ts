import { IsOptional, IsString, IsNumber, IsNotEmpty } from 'class-validator';

export class AddToCartDto {
  // Which store's storefront this cart belongs to — a buyer's cart is
  // scoped per store, not shared across every store they've ever shopped at.
  @IsNotEmpty()
  @IsString()
  storeId: string;

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
