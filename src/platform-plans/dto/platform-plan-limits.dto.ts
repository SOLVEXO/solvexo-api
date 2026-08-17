/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class PlatformPlanLimitsDto {
  @ApiProperty({ description: '-1 = unlimited' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-1)
  maxProducts?: number;

  @ApiProperty({ description: '-1 = unlimited' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-1)
  maxStaffAccounts?: number;

  @ApiProperty()
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1)
  maxPosLocations?: number;

  @ApiProperty()
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  aiCreditsPerMonth?: number;

  @ApiProperty({ description: '0.03 = 3%' })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1)
  transactionFeeRate?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() customDomainAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() whiteLabelAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() loyaltyProgramAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() subscriptionProductsAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() advancedAnalyticsAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() abandonedCartRecoveryAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() emailCampaignsAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() apiWebhooksAllowed?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() dedicatedAccountManager?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() prioritySupport?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() marketplaceFeaturedBadge?: boolean;

  @ApiProperty({ required: false })
  @IsOptional() @Type(() => Number) @IsNumber()
  slaUptimePercent?: number;

  @ApiProperty({ required: false, description: 'Gates SEO Audit, Score Engine, Technical Checklist automation' })
  @IsOptional() @IsBoolean() advancedSeoToolsAllowed?: boolean;
  @ApiProperty({ required: false, description: 'Gates AI-generated SEO suggestions (consumes AiCreditsWallet)' })
  @IsOptional() @IsBoolean() seoAiSuggestionsAllowed?: boolean;
  @ApiProperty({ required: false, description: 'Gates per-store Google Search Console / Bing Webmaster integration' })
  @IsOptional() @IsBoolean() searchConsoleIntegrationAllowed?: boolean;
  @ApiProperty({ required: false, description: 'Gates seller-managed redirect rules & canonical overrides' })
  @IsOptional() @IsBoolean() customRedirectsAllowed?: boolean;
}
