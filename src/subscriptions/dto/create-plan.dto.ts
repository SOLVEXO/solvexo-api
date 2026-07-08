/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsOptional, IsNumber,
  IsEnum, IsArray, IsPositive, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PlanBenefitDto } from './plan-benefit.dto';

export class CreatePlanDto {
  @ApiProperty({ example: 'Pro Plan' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false, example: 'Everything you need to grow your business' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 29.99, description: 'Monthly price in USD — system of record, used for all billing' })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monthlyPriceUSD: number;

  @ApiProperty({ required: false, example: 299.99, description: 'Yearly price in USD (optional). Leave blank to offer monthly only.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  yearlyPriceUSD?: number;

  @ApiProperty({
    required: false,
    enum: ['USD', 'PKR'],
    default: 'USD',
    description: 'Cosmetic display currency for customer-facing pages. Does NOT affect billing or invoicing.',
  })
  @IsOptional()
  @IsEnum(['USD', 'PKR'])
  displayCurrency?: string;

  @ApiProperty({
    required: false,
    type: [String],
    example: ['Unlimited downloads', 'Priority support', 'Advanced analytics'],
    description: 'List of feature bullets shown on the plan card',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @ApiProperty({
    required: false,
    type: [PlanBenefitDto],
    description: 'Structured, server-enforced benefits (discount, shipping, early access, loyalty multiplier, credits, priority support/booking).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanBenefitDto)
  benefits?: PlanBenefitDto[];
}
