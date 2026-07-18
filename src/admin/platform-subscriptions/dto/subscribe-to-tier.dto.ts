/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { StorePlan } from '../../store/schemas/store.schema';

export class SubscribeToTierDto {
  @ApiProperty({ enum: Object.values(StorePlan).filter((t) => t !== StorePlan.STARTER) })
  @IsEnum(StorePlan)
  tier: StorePlan;

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  billingInterval: 'monthly' | 'yearly';
}
