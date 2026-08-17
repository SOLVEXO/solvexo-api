/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum } from 'class-validator';

export class SubscribeDto {
  @ApiProperty({ example: '665plan001', description: 'SubscriptionPlan _id to subscribe to' })
  @IsString()
  @IsNotEmpty()
  planId: string;

  @ApiProperty({ enum: ['monthly', 'yearly'] })
  @IsEnum(['monthly', 'yearly'])
  billingInterval: 'monthly' | 'yearly';
}
