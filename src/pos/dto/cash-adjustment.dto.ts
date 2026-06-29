/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsString, IsNotEmpty, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CashAdjustmentDto {
  @ApiProperty({ enum: ['cash_in', 'cash_out'], description: 'cash_in = petty cash added, cash_out = cash removed' })
  @IsEnum(['cash_in', 'cash_out'])
  type: 'cash_in' | 'cash_out';

  @ApiProperty({ example: 50 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'Petty cash for supplies' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty({ example: '664employee1' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;
}
