/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() renewalReminders?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() paymentFailedAlerts?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() prorationReceipts?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() cancellationConfirmations?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() planChangeUpdates?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() marketingTips?: boolean;
}
