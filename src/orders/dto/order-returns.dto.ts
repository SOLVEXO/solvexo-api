/* eslint-disable prettier/prettier */
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsMongoId, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReceiveReturnDto {
  /** OrderItem ids (on this store's sub-order) whose returned goods arrived. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsMongoId({ each: true })
  itemIds: string[];

  /** Default for every line: back to sellable stock, damaged stock, or untouched (default). */
  @IsOptional() @IsIn(['restock', 'damaged', 'none']) restock?: 'restock' | 'damaged' | 'none';

  /** Optional per-line override: { [itemId]: 'restock' | 'damaged' | 'none' }. */
  @IsOptional() @IsObject() restockDecisions?: Record<string, string>;

  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

export class RefundReturnDto {
  /** OrderItem ids (already marked received) to refund. */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsMongoId({ each: true })
  itemIds: string[];

  /** Shopify "Refund to": the original payment method (default) or store credit. */
  @IsOptional() @IsIn(['original', 'store_credit']) refundTo?: 'original' | 'store_credit';

  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
