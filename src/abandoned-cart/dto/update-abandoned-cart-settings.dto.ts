/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsNumber, IsString, Min, MaxLength } from 'class-validator';

export class UpdateAbandonedCartSettingsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, example: 60 })
  @IsOptional()
  @IsNumber()
  @Min(5)
  delayMinutes?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}
