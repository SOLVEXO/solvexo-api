/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateIdentityBannerDto {
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showFollowButton?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showMessageButton?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showLoyaltyButton?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showMembershipButton?: boolean;
}
