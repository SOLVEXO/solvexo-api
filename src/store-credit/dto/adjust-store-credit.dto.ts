/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class AdjustStoreCreditDto {
  @ApiProperty({ example: 25, description: 'Positive = add credit, negative = remove credit (in the store currency)' })
  @Type(() => Number) @IsNumber() @IsNotEmpty()
  amount: number;

  @ApiProperty({ required: false, maxLength: 300 })
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;

  @ApiProperty({ required: false, description: 'ISO date after which the ADDED credit expires (only when adding)' })
  @IsOptional() @IsDateString()
  expiresAt?: string;
}
