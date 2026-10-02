/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsOptional, IsBoolean, Length, Matches } from 'class-validator';

export class AddPayoutMethodDto {
  @ApiProperty({ enum: ['bank_transfer', 'jazzcash', 'easypaisa', 'paypal', 'stripe'] })
  @IsEnum(['bank_transfer', 'jazzcash', 'easypaisa', 'paypal', 'stripe'])
  type: string;

  // Any ISO-4217 code, not just USD/PKR: a store can hold balances in every
  // currency its markets support (see SellerBalance.currency, which has no
  // enum), so a USD/PKR-only check would reject legitimate wallets.
  @ApiProperty({ required: false, example: 'USD', description: 'ISO-4217 code. Defaults to PKR for jazzcash/easypaisa, USD otherwise' })
  @IsOptional() @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO currency code' }) currency?: string;

  // Bank transfer fields
  @ApiProperty({ required: false, example: 'Chase Bank' })
  @IsOptional() @IsString() bankName?: string;

  @ApiProperty({ required: false, example: 'John Doe' })
  @IsOptional() @IsString() accountHolder?: string;

  @ApiProperty({ required: false, example: '123456789', description: 'Full account number — only last 4 digits are stored' })
  @IsOptional() @IsString() @Length(4, 20) accountNumber?: string;

  @ApiProperty({ required: false, example: '021000021' })
  @IsOptional() @IsString() routingNumber?: string;

  // Stripe / PayPal
  @ApiProperty({ required: false, example: 'seller@paypal.com or acct_stripe_id' })
  @IsOptional() @IsString() @IsNotEmpty() externalAccountId?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional() @IsBoolean() setAsDefault?: boolean;
}
