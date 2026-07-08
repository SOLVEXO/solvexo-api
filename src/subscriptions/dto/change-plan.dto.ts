/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum } from 'class-validator';

export class ChangePlanDto {
  @ApiProperty({ example: '665plan002', description: 'SubscriptionPlan _id to switch to — must belong to the same store' })
  @IsString()
  @IsNotEmpty()
  newPlanId: string;

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  newBillingInterval: 'monthly' | 'yearly';
}
