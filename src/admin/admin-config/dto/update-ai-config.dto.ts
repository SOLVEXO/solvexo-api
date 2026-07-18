/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateAiConfigDto {
  @ApiProperty({ required: false, example: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyCreditLimit?: number;

  @ApiProperty({ required: false, example: 'claude-sonnet-5' })
  @IsOptional()
  @IsString()
  aiModel?: string;
}
