/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateIdentityBannerDto {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showFollowButton?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showMessageButton?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showLoyaltyButton?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showMembershipButton?: boolean;

  @ApiProperty({ required: false, enum: ['standard', 'compact', 'immersive'] })
  @IsOptional() @IsIn(['standard', 'compact', 'immersive']) layout?: 'standard' | 'compact' | 'immersive';
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showBadges?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showFollowerCount?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showProductCount?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showRating?: boolean;
  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsInt() @Min(1) @Max(10) descriptionMaxLines?: number | null;
}
