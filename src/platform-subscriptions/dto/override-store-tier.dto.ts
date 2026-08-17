/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { StorePlan } from '../../store/schemas/store.schema';

export class OverrideStoreTierDto {
  @ApiProperty({ enum: StorePlan })
  @IsEnum(StorePlan)
  tier: StorePlan;

  @ApiProperty({ required: false, description: 'Internal note — why this store was comped/overridden' })
  @IsOptional()
  @IsString()
  note?: string;
}
