import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AddCurrencyDto {
  @ApiProperty({ example: 'EUR', description: 'Real ISO-4217 3-letter code' })
  @IsString() @IsNotEmpty() code: string;

  @ApiProperty({ example: 0.6, description: 'Lower sane-band bound (units of this currency per 1 USD)' })
  @Type(() => Number) @IsNumber() @Min(0.0001) sanityBandMin: number;

  @ApiProperty({ example: 1.3, description: 'Upper sane-band bound (units of this currency per 1 USD)' })
  @Type(() => Number) @IsNumber() @Min(0.0001) sanityBandMax: number;
}

export class UpdateCurrencyBandDto {
  @ApiProperty({ example: 0.6 })
  @Type(() => Number) @IsNumber() @Min(0.0001) sanityBandMin: number;

  @ApiProperty({ example: 1.3 })
  @Type(() => Number) @IsNumber() @Min(0.0001) sanityBandMax: number;
}
