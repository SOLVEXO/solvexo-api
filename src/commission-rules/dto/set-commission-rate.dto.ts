/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, Max, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class SetCommissionRateDto {
  @ApiProperty({ example: 0.05, description: 'Commission rate as a 0–1 fraction (0.05 = 5%)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  rate: number;

  @ApiProperty({ required: false, example: 'Negotiated rate for a high-volume seller' })
  @IsOptional()
  @IsString()
  notes?: string;
}
