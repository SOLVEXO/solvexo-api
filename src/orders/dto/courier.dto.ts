/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { COURIER_KEYS } from '../../integrations/couriers/courier.types';
import { FulfilLineDto } from './fulfil-order.dto';

/** PUT /api/orders/courier/book — book ONE order (or a subset of its lines) with a Pakistani courier. */
export class BookCourierDto {
  @IsMongoId() orderId: string;
  @IsMongoId() storeId: string;

  /** Omit to use the store's default courier. */
  @IsOptional() @IsIn(COURIER_KEYS as unknown as string[]) provider?: string;

  /** Partial shipment: book (and fulfil) ONLY these lines/quantities. Omit for the whole order. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => FulfilLineDto)
  items?: FulfilLineDto[];

  /** Overrides the computed/default parcel weight (kg). */
  @IsOptional() @IsNumber() @Min(0.01) @Max(100) weightKg?: number;
  @IsOptional() @IsInt() @Min(1) @Max(99) pieces?: number;

  @IsOptional() @IsBoolean() notifyCustomer?: boolean;
}

/** PUT /api/orders/courier/bulk-book — one courier, many orders; the response is a per-order report. */
export class BulkBookCourierDto {
  @IsMongoId() storeId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsMongoId({ each: true }) orderIds: string[];
  @IsOptional() @IsIn(COURIER_KEYS as unknown as string[]) provider?: string;
  @IsOptional() @IsBoolean() notifyCustomer?: boolean;
}

/** PUT /api/orders/courier/cancel */
export class CancelCourierDto {
  @IsMongoId() storeId: string;
  @IsMongoId() orderId: string;
  @IsMongoId() bookingId: string;
}
