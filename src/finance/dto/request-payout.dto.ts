/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class RequestPayoutDto {
  @ApiProperty({ example: 250.00, description: 'Amount to withdraw (must not exceed available balance)' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ example: '665method001', description: 'PayoutMethod _id to send funds to' })
  @IsString()
  @IsNotEmpty()
  payoutMethodId: string;

  @ApiProperty({ required: false, example: 'Monthly withdrawal' })
  @IsOptional()
  @IsString()
  notes?: string;
}
