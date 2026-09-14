/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested, ArrayMinSize,
} from 'class-validator';

class PurchaseOrderItemDto {
  @IsString() @IsNotEmpty()
  productId: string;

  @IsString() @IsNotEmpty()
  variantId: string;

  @IsNumber() @Min(1)
  quantityOrdered: number;

  @IsNumber() @Min(0)
  unitCost: number;
}

export class CreatePurchaseOrderDto {
  @IsOptional() @IsString()
  supplierId?: string;

  // Required even with a real `supplierId` — a snapshot, same convention as
  // DraftOrder.customerName, so renaming/archiving a Supplier later never
  // silently rewrites an already-placed PO's history.
  @IsString() @IsNotEmpty()
  supplierName: string;

  @IsOptional() @IsString()
  locationId?: string;

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchaseOrderItemDto)
  items: PurchaseOrderItemDto[];

  @IsOptional() @IsNumber() @Min(0)
  shippingCost?: number;

  @IsOptional() @IsNumber() @Min(0)
  taxCost?: number;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsDateString()
  expectedAt?: string;
}
