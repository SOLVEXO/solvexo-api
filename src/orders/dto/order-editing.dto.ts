/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class OrderItemChangeDto {
  @IsMongoId() itemId: string;
  /** 0 removes the item from the order. */
  @IsInt() @Min(0) @Max(999) quantity: number;
}

export class OrderItemAdditionDto {
  @IsMongoId() variantId: string;
  @IsInt() @Min(1) @Max(999) quantity: number;
}

export class EditOrderDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderItemChangeDto)
  changes?: OrderItemChangeDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OrderItemAdditionDto)
  additions?: OrderItemAdditionDto[];

  /** true = only compute and return the summary (Shopify's "Update order" review step); nothing is saved. */
  @IsOptional() @IsBoolean() dryRun?: boolean;

  /** Where a refund for a reduced total goes (paid orders). */
  @IsOptional() @IsIn(['original', 'store_credit']) refundTo?: 'original' | 'store_credit';

  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class OrderCommentDto {
  @IsString() @MaxLength(2000) message: string;
}

export class OrderNoteDto {
  @IsString() @MaxLength(2000) note: string;
}

export class OrderShippingAddressDto {
  @IsString() @MaxLength(120) recipientName: string;
  @IsString() @MaxLength(40) phoneNumber: string;
  @IsString() @MaxLength(200) addressLine1: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
  @IsString() @MaxLength(80) city: string;
  @IsString() @MaxLength(80) state: string;
  @IsString() @MaxLength(20) zipCode: string;
  @IsOptional() @IsString() @MaxLength(80) country?: string;
}
