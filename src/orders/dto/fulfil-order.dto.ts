/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export class FulfilLineDto {
  /** OrderItem._id of the line to ship. */
  @IsMongoId() itemId: string;
  @IsInt() @Min(1) @Max(999) quantity: number;
}

/** POST /api/orders/fulfil/:storeId/:orderId — Shopify "Fulfil items": ship a subset/quantity of the unfulfilled lines. */
export class FulfilOrderDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => FulfilLineDto)
  items: FulfilLineDto[];

  @IsOptional() @IsString() @MaxLength(80) carrier?: string;
  @IsOptional() @IsString() @MaxLength(120) trackingNumber?: string;
  @IsOptional() @IsString() @MaxLength(500) @Matches(/^https?:\/\//i, { message: 'trackingUrl must start with http:// or https://' }) trackingUrl?: string;

  /** Default true — email/notify the buyer. */
  @IsOptional() @IsBoolean() notifyCustomer?: boolean;
}
