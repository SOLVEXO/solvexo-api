/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsNumber, Min } from 'class-validator';

export class UpdateProgramDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pointsExpiryMonths?: number;
}
