import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsOptional, IsNumber, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PaymentLineDto } from './payment.dto';

export class CompleteSaleDto {
  @ApiProperty({ enum: ['cash', 'card', 'other'], description: 'Single-payment form; ignored when `payments` is sent' })
  @IsEnum(['cash', 'card', 'other'])
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
