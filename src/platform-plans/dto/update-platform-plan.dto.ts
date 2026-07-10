/* eslint-disable prettier/prettier */
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsOptional, IsEnum } from 'class-validator';
import { CreatePlatformPlanDto } from './create-platform-plan.dto';

export class UpdatePlatformPlanDto extends PartialType(CreatePlatformPlanDto) {
  @ApiProperty({ required: false, enum: ['active', 'archived'] })
  @IsOptional() @IsEnum(['active', 'archived'])
  status?: string;
}
