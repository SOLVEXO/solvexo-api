/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { PROMOTION_PLACEMENTS, PromotionPlacement } from '../../common/promotion-placements.const';
import { PROMOTION_LINK_TYPES, PromotionLinkType } from '../schemas/promotion-request.schema';

export class CreatePromotionRequestDto {
  @ApiProperty({ enum: PROMOTION_PLACEMENTS })
  @IsIn(PROMOTION_PLACEMENTS)
  placement: PromotionPlacement;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  ctaLabel?: string;

  @ApiProperty({ enum: PROMOTION_LINK_TYPES, default: 'external' })
  @IsOptional()
  @IsIn(PROMOTION_LINK_TYPES)
  linkType?: PromotionLinkType;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  linkTarget?: string;

  @ApiProperty({ required: false, description: 'Note to the admin reviewing this request' })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiProperty()
  @IsDateString()
  startAt: string;

  @ApiProperty()
  @IsDateString()
  endAt: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isPeak?: boolean;
}
