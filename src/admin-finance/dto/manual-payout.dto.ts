/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ManualPayoutDto {
  @ApiProperty({ example: 250.00, description: 'Amount to pay out — must not exceed the seller\'s available balance' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ required: false, description: 'Existing PayoutMethod _id — omit for an off-platform manual payout (e.g. a wire transfer arranged outside the app)' })
  @IsOptional()
  @IsString()
  payoutMethodId?: string;

  @ApiProperty({ required: false, example: 'Manual correction for missed automatic payout' })
  @IsOptional()
  @IsString()
  notes?: string;
}
