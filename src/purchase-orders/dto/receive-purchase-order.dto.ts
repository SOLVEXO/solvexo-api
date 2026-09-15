/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { IsArray, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested, ArrayMinSize } from 'class-validator';

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

  // Only meaningful when the line's variant has `trackLots: true` (see
  // StockLot schema) — a real supplier batch/lot number and/or expiry for
  // THIS specific receipt. Omitted entirely for a non-lot-tracked variant.
  @IsOptional() @IsString()
  lotNumber?: string;

  @IsOptional() @IsDateString()
  expiryDate?: string;

  // Only meaningful when the line's variant has `trackSerials: true` (see
  // StockUnit schema) — one serial number per good unit received. Its
  // length must equal `quantityReceived` exactly (validated in the
  // service, not here, since it's cross-field) — a serial-tracked receipt
  // with no serials supplied is rejected rather than silently skipped.
  @IsOptional() @IsArray() @IsString({ each: true })
  serialNumbers?: string[];
}

export class ReceivePurchaseOrderDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiveLineDto)
  items: ReceiveLineDto[];
}
