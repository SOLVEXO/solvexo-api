/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
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
