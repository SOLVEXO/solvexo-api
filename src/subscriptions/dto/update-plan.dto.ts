/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsNumber,
  IsEnum, IsArray, IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdatePlanDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, description: 'New monthly price in USD. Does not retroactively change active subscriptions.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monthlyPriceUSD?: number;

  @ApiProperty({ required: false, description: 'New yearly price in USD.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  yearlyPriceUSD?: number;

  @ApiProperty({ required: false, enum: ['USD', 'PKR'], description: 'Cosmetic display currency only.' })
  @IsOptional()
  @IsEnum(['USD', 'PKR'])
  displayCurrency?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @ApiProperty({ required: false, enum: ['active', 'archived'] })
  @IsOptional()
  @IsEnum(['active', 'archived'])
  status?: string;
}
