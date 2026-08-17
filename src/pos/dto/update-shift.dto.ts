/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateShiftDto {
  @ApiProperty({ required: false, example: 'Evening Shift' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, example: '14:00' })
  @IsOptional()
  @IsString()
  startTime?: string;

  @ApiProperty({ required: false, example: '22:00' })
  @IsOptional()
  @IsString()
  endTime?: string;

  @ApiProperty({ required: false, example: [1, 2, 3, 4, 5], description: '0=Sun, 6=Sat' })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  daysOfWeek?: number[];

  @ApiProperty({ required: false, enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;
}
