import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export class UpdateAnnouncementStatusDto {
  @ApiProperty({ enum: ['draft', 'published', 'scheduled'] })
  @IsEnum(['draft', 'published', 'scheduled'])
  status: string;

  @ApiProperty({ required: false, example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
