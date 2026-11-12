/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePosSettingsDto {
  @ApiProperty({ required: false, example: 5, description: 'Idle minutes (1–240) before the POS locks to the PIN screen. Default 5.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(240)
  autoLockMinutes?: number;

  @ApiProperty({ required: false, example: 0.05, description: '0.05 = 5% — the server applies it to (subtotal − discount) on every sale; client-sent tax is ignored' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  taxRate?: number;

  @ApiProperty({ required: false, nullable: true, example: 5000, description: 'G2.4: a cashier may add a custom item whose line total is at most this many minor units; above it a manager must approve. null = every custom item needs a manager.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  customItemApprovalAboveMinor?: number | null;

  @ApiProperty({ required: false, description: 'G2.5: may a cashier process a return within the limits below? false = every return needs a manager' })
  @IsOptional() @IsBoolean() cashierReturnsEnabled?: boolean;

  @ApiProperty({ required: false, nullable: true, description: 'G2.5: a return above this amount (minor units) needs a manager; null = no limit' })
  @IsOptional() @IsInt() @Min(0) returnApprovalAboveMinor?: number | null;

  @ApiProperty({ required: false, nullable: true, description: 'G2.5: a return later than this many days after the sale needs a manager; null = no limit' })
  @IsOptional() @IsInt() @Min(0) returnApprovalAfterDays?: number | null;

  // G2.6 store tax profile (owner-only route): as registered with the tax authority. Optional now; required later when fiscal integration is enabled.
  @ApiProperty({ required: false, nullable: true, example: '1234567-8' })
  @IsOptional() @IsString() @Matches(/^[0-9-]{7,15}$/, { message: 'NTN must be 7 to 15 digits (dash allowed)' }) taxNtn?: string | null;
  @ApiProperty({ required: false, nullable: true, example: '3277876123456' })
  @IsOptional() @IsString() @Matches(/^[0-9A-Za-z-]{5,20}$/, { message: 'STRN must be 5 to 20 letters, digits or dashes' }) taxStrn?: string | null;
  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsString() @MaxLength(160) taxLegalName?: string | null;
  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsString() @MaxLength(300) taxRegisteredAddress?: string | null;
  @ApiProperty({ required: false, enum: ['standard', 'exempt'] })
  @IsOptional() @IsIn(['standard', 'exempt']) defaultTaxCategory?: string;

  @ApiProperty({ required: false, example: 'Thank you for shopping with us!' })
  @IsOptional()
  @IsString()
  receiptHeader?: string;

  @ApiProperty({ required: false, example: 'Returns accepted within 7 days' })
  @IsOptional()
  @IsString()
  receiptFooter?: string;

  @ApiProperty({ required: false, example: 'My Store LLC' })
  @IsOptional()
  @IsString()
  businessName?: string;

  @ApiProperty({ required: false, example: '123 Main St, Karachi' })
  @IsOptional()
  @IsString()
  businessAddress?: string;

  @ApiProperty({ required: false, example: 'Rs' })
  @IsOptional()
  @IsString()
  currencySymbol?: string;

  @ApiProperty({ required: false, example: 'NTN 1234567-8', description: 'Printed on receipts' })
  @IsOptional()
  @IsString()
  businessTaxId?: string;
}
