/* eslint-disable prettier/prettier */
import {
  ArrayMaxSize, IsArray, IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString,
  IsUrl, Matches, Max, MaxLength, Min, IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TONES, CAMPAIGN_GOALS, ENHANCEMENT_TYPES } from './generate.dto';

/** Shared by every admin/platform generate DTO — same "regenerate links the session" contract as the seller side. */
class BaseAdminGenerateDto {
  @IsOptional() @IsMongoId()
  regenerateFromId?: string;
}

/** Platform SEO Booster — optimizes a marketplace-owned title (landing page, category, homepage copy). No productId/storeId: this is never seller content. */
export class AdminGenerateSeoDto extends BaseAdminGenerateDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true })
  currentTags?: string[];
}

/** Platform email campaign — for admin Announcements, not tied to any seller's products. */
export class AdminGenerateEmailDto extends BaseAdminGenerateDto {
  @IsIn(CAMPAIGN_GOALS)
  campaignGoal: (typeof CAMPAIGN_GOALS)[number];

  @IsIn(TONES)
  tone: (typeof TONES)[number];
}

/** Platform image enhancement — for admin Banners/marketing assets. */
export class AdminGenerateImageEnhanceDto extends BaseAdminGenerateDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  @Matches(/\.(jpg|jpeg|png|webp)(\?.*)?$/i, { message: 'imageUrl must point to a jpg, jpeg, png, or webp image' })
  imageUrl: string;

  @IsIn(ENHANCEMENT_TYPES)
  enhancementType: (typeof ENHANCEMENT_TYPES)[number];
}

export class AdjustWalletDto {
  @IsIn(['grant', 'deduct'])
  direction: 'grant' | 'deduct';

  @Type(() => Number) @IsNumber() @Min(1) @Max(100_000)
  amount: number;

  @IsString() @IsNotEmpty() @MaxLength(300)
  reason: string;
}
