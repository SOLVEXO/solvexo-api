/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export const ADDON_TYPES = [
  'extra_ai_credits', 'extra_staff_seat', 'priority_marketplace_placement',
  'advanced_tax_compliance', 'sms_notifications',
] as const;

export class PurchaseAddonDto {
  @ApiProperty({ enum: ADDON_TYPES })
  @IsEnum(ADDON_TYPES)
  addonType: (typeof ADDON_TYPES)[number];

  @ApiProperty({ required: false, default: 1, description: 'Units to purchase (e.g. 2 = 1000 extra AI credits at $10/500)' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  quantity?: number;
}
