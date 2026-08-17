import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export class UpdateCampaignStatusDto {
  @ApiProperty({ enum: ['draft', 'active', 'ended'] })
  @IsEnum(['draft', 'active', 'ended'])
  status: string;
}
