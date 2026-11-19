/* eslint-disable prettier/prettier */
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CAMPAIGN_CHANNELS } from '../schemas/marketing-campaign.schema';

// UTM values travel in URLs: letters, digits, dash, underscore, dot only.
const UTM = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;

export class CreateMarketingCampaignDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsIn(CAMPAIGN_CHANNELS as unknown as string[]) channel?: string;
  /** Left out = made from the name. */
  @IsOptional() @Matches(UTM, { message: 'Campaign tag can only use letters, numbers, dash, underscore and dot' }) utmCampaign?: string;
  @IsOptional() @Matches(UTM, { message: 'Source can only use letters, numbers, dash, underscore and dot' }) utmSource?: string | null;
  @IsOptional() @Matches(UTM, { message: 'Medium can only use letters, numbers, dash, underscore and dot' }) utmMedium?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class UpdateMarketingCampaignDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsIn(CAMPAIGN_CHANNELS as unknown as string[]) channel?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsIn(['active', 'archived']) status?: 'active' | 'archived';
}
