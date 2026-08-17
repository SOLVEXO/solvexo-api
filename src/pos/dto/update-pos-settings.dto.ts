/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePosSettingsDto {
  @ApiProperty({ required: false, example: 0.05, description: '0.05 = 5% — applied to subtotal when sale.tax not provided' })
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
}
