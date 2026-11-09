/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** One tender collected for a sale. For cash, `amount` is what the customer HANDED OVER (may exceed what is owed — the server computes the change). */
export class PaymentLineDto {
  @ApiProperty({ enum: ['cash', 'card', 'other', 'raast_qr', 'store_credit'] })
  @IsEnum(['cash', 'card', 'other', 'raast_qr', 'store_credit'])
  method: string;

  @ApiProperty({ example: 40 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;
  @ApiProperty({ required: false, example: 5876, description: `G1b: integer twin of amount (minor units). Cross-check only.` })
  @IsOptional()
  // no strict validation on purpose: a malformed twin must never reject a sale — the server records it as a mismatch and uses its own values
  amountMinor?: number;

  @ApiProperty({ required: false, description: 'raast_qr only: the id of the CONFIRMED payment (POST pos/payments/intents) this line settles. The sale is accepted only if that payment is confirmed, unused, in this shift, and for exactly this amount.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  intentId?: string;

  @ApiProperty({ required: false, example: 'AUTH-123456', description: 'Card authorisation code / bank transfer reference' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
