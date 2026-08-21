/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const STATUS_VALUES = ['draft', 'published', 'archived'] as const;

export class SetThemeStatusDto {
  @ApiProperty({ enum: STATUS_VALUES }) @IsIn(STATUS_VALUES) status: 'draft' | 'published' | 'archived';
}
