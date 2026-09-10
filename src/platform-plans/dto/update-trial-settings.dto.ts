/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';

export class UpdateTrialSettingsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  durationDays?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  paymentMethodRequired?: boolean;

  @ApiProperty({ required: false, enum: ['new_stores_only'] })
  @IsOptional()
  @IsIn(['new_stores_only'])
  eligibility?: string;
}
