import { IsOptional, IsString, IsInt, IsNotEmpty, Min, Max } from 'class-validator';

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

  // Positive whole number only — a zero/negative/fractional quantity would
  // produce a negative or free line total at checkout.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  quantity?: number;
}
