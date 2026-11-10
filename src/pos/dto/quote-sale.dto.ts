/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SaleItemDto } from './create-sale.dto';

/** Price a cart without selling it (POST /pos/sales/quote). No side effects, no stock taken. */
export class QuoteSaleDto {
  @ApiProperty({ required: false, description: 'Price the cart with this POS coupon (validated like a sale)' })
  @IsOptional() @IsString() @MaxLength(40)
  couponCode?: string;

  @ApiProperty() @IsString() @IsNotEmpty() storeId: string;

  @ApiProperty({ required: false, description: 'G4.5: price with this price book' })
  @IsOptional() @IsString() @MaxLength(40)
  priceBookId?: string;

  @ApiProperty({ required: false, description: 'G4.5: the customer (their price book applies)' })
  @IsOptional() @IsString() @MaxLength(40)
  customerId?: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiProperty({ enum: ['amount', 'percent'], required: false })
  @IsOptional() @IsEnum(['amount', 'percent'])
  discountType?: 'amount' | 'percent';

  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  discountValue?: number;

  @ApiProperty({ required: false, description: 'Price with this settingsVersion if it is still within the offline window; otherwise the current one' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  settingsVersion?: number;
}
