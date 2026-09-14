/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested, ArrayMinSize } from 'class-validator';

class ReceiveLineDto {
  // The PurchaseOrderItem sub-document's own _id (not productId/variantId) —
  // a PO can carry the same variant more than once across separate lines in
  // principle, so the line itself, not the SKU, is the unambiguous target.
  @IsString() @IsNotEmpty()
  itemId: string;

  @IsNumber() @Min(0)
  quantityReceived: number;

  @IsOptional() @IsNumber() @Min(0)
  quantityDamaged?: number;
}

export class ReceivePurchaseOrderDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiveLineDto)
  items: ReceiveLineDto[];
}
