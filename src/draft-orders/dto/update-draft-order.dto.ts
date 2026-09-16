/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { DraftOrderShippingAddressDto } from './create-draft-order.dto';

class DraftOrderItemDto {
  @IsString() @IsNotEmpty()
  productId: string;

  @IsString() @IsNotEmpty()
  variantId: string;

  @IsNumber() @Min(1)
  quantity: number;

  @IsOptional() @IsNumber() @Min(0)
  unitPrice?: number;
}

export class UpdateDraftOrderDto {
  @IsOptional() @IsString()
  customerId?: string;

  @IsOptional() @IsString()
  customerName?: string;

  @IsOptional() @IsString()
  customerEmail?: string;

  @IsOptional() @IsString()
  customerPhone?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DraftOrderItemDto)
  items?: DraftOrderItemDto[];

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

  @IsOptional() @ValidateNested() @Type(() => DraftOrderShippingAddressDto)
  shippingAddress?: DraftOrderShippingAddressDto;

  @IsOptional() @IsIn(['due_on_receipt', 'net_15', 'net_30', 'net_60'])
  paymentTerms?: 'due_on_receipt' | 'net_15' | 'net_30' | 'net_60';
}
