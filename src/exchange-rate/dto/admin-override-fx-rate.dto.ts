import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AdminOverrideFxRateDto {
  @ApiProperty({ example: 'PKR' })
  @IsString() currency: string;

  @ApiProperty({ example: 278, description: 'Units of `currency` per 1 USD' })
  @Type(() => Number) @IsNumber() @Min(0.000001) ratePerUSD: number;
}
