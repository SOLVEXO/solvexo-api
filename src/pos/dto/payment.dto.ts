/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** One tender collected for a sale. For cash, `amount` is what the customer HANDED OVER (may exceed what is owed — the server computes the change). */
export class PaymentLineDto {
  @ApiProperty({ enum: ['cash', 'card', 'other'] })
  @IsEnum(['cash', 'card', 'other'])
  method: string;

  @ApiProperty({ example: 40 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ required: false, example: 'AUTH-123456', description: 'Card authorisation code / bank transfer reference' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}
