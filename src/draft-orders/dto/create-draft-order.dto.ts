/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested, ArrayMinSize,
} from 'class-validator';

class DraftOrderItemDto {
  @IsString() @IsNotEmpty()
  productId: string;

  @IsString() @IsNotEmpty()
  variantId: string;

  @IsNumber() @Min(1)
  quantity: number;

  // Optional — omit to use the variant's current price; pass to override
  // (a phone-order negotiated price, a wholesale rate, a goodwill discount).
  @IsOptional() @IsNumber() @Min(0)
  unitPrice?: number;
}

export class CreateDraftOrderDto {
  // Either a real registered buyer id, or omit and describe a guest below
  // (a guest draft can be saved/priced/invoiced but not converted to a real
  // Order until a registered account is attached — see DraftOrder.customerId).
  @IsOptional() @IsString()
  customerId?: string;

  @IsString() @IsNotEmpty()
  customerName: string;

  @IsOptional() @IsString()
  customerEmail?: string;

  @IsOptional() @IsString()
  customerPhone?: string;

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => DraftOrderItemDto)
  items: DraftOrderItemDto[];

  @IsOptional() @IsIn(['percentage', 'fixed'])
  discountType?: 'percentage' | 'fixed';

  @IsOptional() @IsNumber() @Min(0)
  discountValue?: number;

  @IsOptional() @IsNumber() @Min(0)
  shippingAmount?: number;

  @IsOptional() @IsNumber() @Min(0)
  taxAmount?: number;

  @IsOptional() @IsString()
  notes?: string;
}
