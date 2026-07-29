/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePayoutConfigDto {
  @ApiProperty({ required: false, example: 5 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPayoutUSD?: number;

  @ApiProperty({ required: false, example: 1500 })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minPayoutPKR?: number;
}
