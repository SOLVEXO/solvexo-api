/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum } from 'class-validator';

export class SubscribePlatformPlanDto {
  @ApiProperty({ description: 'PlatformPlan _id to subscribe this store to' })
  @IsString() @IsNotEmpty()
  platformPlanId: string;

  @ApiProperty({ enum: ['monthly', 'yearly'], default: 'monthly' })
  @IsEnum(['monthly', 'yearly'])
  billingInterval: 'monthly' | 'yearly';
}

export class ChangePlatformPlanDto {
  @ApiProperty({ description: 'PlatformPlan _id to switch this store to' })
  @IsString() @IsNotEmpty()
  newPlatformPlanId: string;

  @ApiProperty({ enum: ['monthly', 'yearly'], default: 'monthly' })
  @IsEnum(['monthly', 'yearly'])
  newBillingInterval: 'monthly' | 'yearly';
}
