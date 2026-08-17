/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn } from 'class-validator';

export const GRANTABLE_STORE_BADGES = ['verified', 'top_seller', 'verified_educator'] as const;

export class SetStoreBadgeDto {
  @ApiProperty({ enum: GRANTABLE_STORE_BADGES, example: 'verified_educator' })
  @IsIn(GRANTABLE_STORE_BADGES)
  badge: (typeof GRANTABLE_STORE_BADGES)[number];

  @ApiProperty({ example: true, description: 'true grants the badge, false revokes it' })
  @IsBoolean()
  grant: boolean;
}
