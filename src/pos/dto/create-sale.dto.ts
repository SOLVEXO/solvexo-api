/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsArray, ValidateNested,
  IsNumber, IsOptional, IsEnum, Min, Max, IsInt, IsDateString, IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentLineDto } from './payment.dto';

export class SaleItemDto {
  @ApiProperty({ example: '664product1' })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ example: '664variant1' })
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  qty: number;

  @ApiProperty({ required: false, example: 19.99, description: 'Offline replay only: the unit price the till actually CHARGED. Recorded as the price of the line if it matches a genuine price of the variant within the offline window; otherwise recorded anyway and flagged unverified. Ignored for ordinary online sales.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @ApiProperty({ required: false, example: 5876, description: `G1b: integer twin of unitPrice in the currency's minor unit. Cross-check only: if both are sent and disagree the sale is rejected (MONEY_FIELD_MISMATCH).` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  unitPriceMinor?: number;
}

export class CreateSaleDto {
  @ApiProperty({ example: '664abc123' })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({ example: '664session1' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @ApiProperty({ example: '664register1' })
  @IsString()
  @IsNotEmpty()
  registerId: string;

  @ApiProperty({ example: '664employee1' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiProperty({ example: 0, required: false, description: 'Flat discount amount (legacy form — prefer discountType + discountValue)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @ApiProperty({ enum: ['amount', 'percent'], required: false, description: 'How `discountValue` is read; the server computes the discount amount' })
  @IsOptional()
  @IsEnum(['amount', 'percent'])
  discountType?: 'amount' | 'percent';

  @ApiProperty({ example: 10, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountValue?: number;
  @ApiProperty({ required: false, example: 5876, description: `G1b: integer twin of discountValue — only when discountType is 'amount' (a percentage is not money). Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  discountValueMinor?: number;

  @ApiProperty({ required: false, deprecated: true, description: 'IGNORED. Tax is computed by the server from the store tax rate.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;

  @ApiProperty({ required: false, example: 58.76, description: 'The total the device displayed. The server computes its own; a difference beyond one minor unit is rejected (TOTAL_MISMATCH)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  clientTotal?: number;
  @ApiProperty({ required: false, example: 5876, description: `G1b: integer twin of clientTotal (minor units). Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  clientTotalMinor?: number;

  @ApiProperty({ enum: ['cash', 'card', 'other'], default: 'cash', description: 'Single-payment form; ignored when `payments` is sent' })
  @IsEnum(['cash', 'card', 'other'])
  paymentMethod: string;

  @ApiProperty({ type: [PaymentLineDto], required: false, description: 'Split tender: one entry per tender. Overrides paymentMethod.' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentLineDto)
  payments?: PaymentLineDto[];

  @ApiProperty({ required: false, example: 50, description: 'Single cash payment only: what the customer handed over (server computes change)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountTendered?: number;
  @ApiProperty({ required: false, example: 5876, description: `G1b: integer twin of amountTendered (minor units). Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  amountTenderedMinor?: number;

  @ApiProperty({ required: false, description: 'Single non-cash payment: card auth code / bank reference' })
  @IsOptional()
  @IsString()
  paymentReference?: string;

  @ApiProperty({ required: false, example: '664user1' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiProperty({ required: false, example: 'Sarah M.' })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ required: false, example: 'Customer requested gift wrap' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ enum: ['completed', 'held'], default: 'completed', required: false })
  @IsOptional()
  @IsEnum(['completed', 'held'])
  status?: 'completed' | 'held';

  @ApiProperty({ required: false, example: 3, description: 'The POS settingsVersion (tax rate…) the device priced this sale with — see GET /pos/settings and POST /pos/sales/quote' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  settingsVersion?: number;

  @ApiProperty({ required: false, description: 'ISO time the sale was really made on the device (offline sales)' })
  @IsOptional()
  @IsDateString()
  clientCreatedAt?: string;

  @ApiProperty({ required: false, description: 'true when this is a queued sale being replayed after the device was offline' })
  @IsOptional()
  @IsBoolean()
  offline?: boolean;

  @ApiProperty({ required: false, example: 'idem_abc123', description: 'Client-generated key — prevents duplicate sales on retry' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
