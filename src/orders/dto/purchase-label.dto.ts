/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsMongoId, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { FulfilLineDto } from './fulfil-order.dto';

/** PUT /api/orders/purchase-shipping-label — rateId/packageId are optional (no rateId = cheapest rate). */
export class PurchaseShippingLabelDto {
  @IsMongoId() orderId: string;
  @IsMongoId() storeId: string;

  /** A rate id returned by GET label-rates (Shippo object id). */
  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[\w-]+$/) rateId?: string;

  /** Id of one of the store's saved packages. */
  @IsOptional() @IsString() @MaxLength(40) @Matches(/^[\w-]+$/) packageId?: string;

  /** Partial shipment: label (and fulfil) ONLY these lines/quantities. Omit to label the whole order. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => FulfilLineDto)
  items?: FulfilLineDto[];

  /** Partial shipment only — default true. */
  @IsOptional() @IsBoolean() notifyCustomer?: boolean;
}

/** PUT /api/orders/purchase-return-label — Shippo label from the buyer back to the store for approved returned lines. */
export class PurchaseReturnLabelDto {
  @IsMongoId() orderId: string;
  @IsMongoId() storeId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsMongoId({ each: true })
  itemIds: string[];

  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[\w-]+$/) rateId?: string;
  @IsOptional() @IsString() @MaxLength(40) @Matches(/^[\w-]+$/) packageId?: string;

  /** Default true — email/notify the buyer the label. */
  @IsOptional() @IsBoolean() notifyCustomer?: boolean;
}

/** PUT /api/orders/tracking/:storeId/:orderId — edit the legacy (pre-shipments) tracking of a shipped order. */
export class UpdateTrackingDto {
  @IsOptional() @IsString() @MaxLength(80) carrier?: string;
  @IsOptional() @IsString() @MaxLength(120) trackingNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) @Matches(/^https?:\/\//i, { message: 'trackingUrl must start with http:// or https://' }) trackingUrl?: string;
}
