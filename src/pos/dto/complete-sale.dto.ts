import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsInt, IsOptional, IsNumber, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentLineDto } from './payment.dto';

export class CompleteSaleDto {
  @ApiProperty({ enum: ['cash', 'card', 'other', 'raast_qr'], description: 'Single-payment form; ignored when `payments` is sent' })
  @IsEnum(['cash', 'card', 'other', 'raast_qr'])
  paymentMethod: string;

  @ApiProperty({ type: [PaymentLineDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PaymentLineDto)
  payments?: PaymentLineDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amountTendered?: number;
  @ApiProperty({ required: false, description: `G1b: integer twin (minor units). Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  amountTenderedMinor?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  paymentReference?: string;

  @ApiProperty({ required: false, example: 0, description: 'Flat discount (legacy form — prefer discountType + discountValue)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @ApiProperty({ enum: ['amount', 'percent'], required: false })
  @IsOptional()
  @IsEnum(['amount', 'percent'])
  discountType?: 'amount' | 'percent';

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountValue?: number;
  @ApiProperty({ required: false, description: `G1b: integer twin of discountValue — only for an 'amount' discount. Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  discountValueMinor?: number;

  @ApiProperty({ required: false, deprecated: true, description: 'IGNORED — tax is computed by the server' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;

  @ApiProperty({ required: false, description: 'The total the device displayed; mismatch beyond one minor unit → TOTAL_MISMATCH' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  clientTotal?: number;
  @ApiProperty({ required: false, description: `G1b: integer twin (minor units). Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  clientTotalMinor?: number;

  @ApiProperty({ required: false, description: 'The settingsVersion the device priced this with' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  settingsVersion?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
