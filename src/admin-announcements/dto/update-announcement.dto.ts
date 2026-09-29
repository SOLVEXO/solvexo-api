/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateAnnouncementDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  message?: string;

  @ApiProperty({ required: false, example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}
