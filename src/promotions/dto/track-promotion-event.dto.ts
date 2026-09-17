/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const ENTITY_TYPES = ['store_banner', 'promotion_request', 'banner'] as const;
const DEVICES = ['desktop', 'mobile', 'tablet'] as const;

export class TrackPromotionEventDto {
  @ApiProperty({ enum: ENTITY_TYPES })
  @IsIn(ENTITY_TYPES)
  entityType: (typeof ENTITY_TYPES)[number];

  @ApiProperty()
  @IsString()
  entityId: string;

  @ApiProperty({ enum: DEVICES, required: false })
  @IsOptional()
  @IsIn(DEVICES)
  device?: (typeof DEVICES)[number];

  // Client-supplied best-effort hints — this app has no IP-geolocation
  // service, so these stay null unless the caller genuinely has them rather
  // than being guessed/faked server-side.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  city?: string;

  // The caller's own store — cross-checked against the entity's real
  // storeId server-side so this beacon can't inflate/pollute a different
  // store's stats by POSTing a copied or guessed entityId.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  storeId?: string;
}
