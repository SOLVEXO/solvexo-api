/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CampaignSegmentDto } from './campaign-segment.dto';

export class CreateEmailCampaignDto {
  @ApiProperty({ example: 'September clearance blast' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: '20% off everything this weekend only' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject: string;

  @ApiProperty({ example: 'Hi {{customerName}}, ...' })
  @IsString()
  @IsNotEmpty()
  message: string;

  @ApiProperty({ enum: ['all', 'buyers', 'abandoned'] })
  @IsIn(['all', 'buyers', 'abandoned'])
  audience: 'all' | 'buyers' | 'abandoned';

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
