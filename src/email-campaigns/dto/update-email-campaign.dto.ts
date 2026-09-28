/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsISO8601, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CampaignSegmentDto } from './campaign-segment.dto';

// A campaign can only be edited (or scheduled) while it's still a 'draft' —
// enforced in EmailCampaignsService, not here.
export class UpdateEmailCampaignDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiProperty({ required: false, enum: ['all', 'buyers', 'abandoned'] })
  @IsOptional()
  @IsIn(['all', 'buyers', 'abandoned'])
  audience?: 'all' | 'buyers' | 'abandoned';

  @ApiProperty({ required: false, type: CampaignSegmentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CampaignSegmentDto)
  segment?: CampaignSegmentDto | null;

  @ApiProperty({ required: false, description: 'Editor block design (JSON); `message` is its rendered HTML' })
  @IsOptional()
  @IsObject()
  design?: Record<string, unknown> | null;
}

export class ScheduleEmailCampaignDto {
  @ApiProperty({ example: '2026-09-20T09:00:00.000Z' })
  @IsISO8601()
  scheduledAt: string;
}
