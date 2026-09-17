/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsInt, Min, Max,
  IsArray, IsEnum, IsDateString, ValidateNested, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class WeeklyRuleDto {
  @ApiProperty({ example: 1, description: '0=Sunday .. 6=Saturday' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @Matches(HHMM_REGEX, { message: 'startTime must be in "HH:mm" 24h format' })
  startTime: string;

  @ApiProperty({ example: '17:00' })
  @IsString()
  @Matches(HHMM_REGEX, { message: 'endTime must be in "HH:mm" 24h format' })
  endTime: string;
}

export class AvailabilityExceptionDto {
  @ApiProperty({ example: '2026-12-25' })
  @IsDateString()
  date: string;

  @ApiProperty({ enum: ['closed', 'custom'] })
  @IsEnum(['closed', 'custom'])
  type: 'closed' | 'custom';

  @ApiProperty({ required: false, example: '10:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM_REGEX, { message: 'customStart must be in "HH:mm" 24h format' })
  customStart?: string;

  @ApiProperty({ required: false, example: '14:00' })
  @IsOptional()
  @IsString()
  @Matches(HHMM_REGEX, { message: 'customEnd must be in "HH:mm" 24h format' })
  customEnd?: string;
}

export class UpdateAvailabilityDto {
  @ApiProperty({ type: [WeeklyRuleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeeklyRuleDto)
  weeklyRules: WeeklyRuleDto[];

  @ApiProperty({ required: false, type: [AvailabilityExceptionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AvailabilityExceptionDto)
  exceptions?: AvailabilityExceptionDto[];
}
