/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsDateString, Matches } from 'class-validator';

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class RescheduleBookingDto {
  @ApiProperty({ example: '2026-09-02' })
  @IsDateString()
  date: string;

  @ApiProperty({ example: '14:00' })
  @IsString()
  @Matches(HHMM_REGEX, { message: 'startTime must be in "HH:mm" 24h format' })
  startTime: string;
}
