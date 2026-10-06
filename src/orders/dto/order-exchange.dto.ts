/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ExchangeReplacementDto {
  @IsMongoId() variantId: string;
  @IsInt() @Min(1) @Max(999) quantity: number;
}

export class CreateExchangeDto {
  /** OrderItem ids (on this store's sub-order) whose pending return is resolved by this exchange. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsMongoId({ each: true })
  returnItemIds: string[];

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ExchangeReplacementDto)
  replacements: ExchangeReplacementDto[];

  /** Where a refund goes when the replacement is cheaper than the returned items. */
  @IsOptional() @IsIn(['original', 'store_credit']) refundTo?: 'original' | 'store_credit';

  /** What happens to the returned units: back to sellable stock, damaged stock, or untouched (default). */
  @IsOptional() @IsIn(['restock', 'damaged', 'none']) restock?: 'restock' | 'damaged' | 'none';

  /** true = only compute the quote (Shopify's review step); nothing is saved. */
  @IsOptional() @IsBoolean() dryRun?: boolean;

  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
