/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional, IsPositive, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PlanBenefitDto } from './plan-benefit.dto';

export class EstimatePlanHealthDto {
  @ApiProperty({ required: false, type: [PlanBenefitDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanBenefitDto)
  benefits?: PlanBenefitDto[];

  @ApiProperty({ example: 29.99 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monthlyPriceUSD: number;
}
