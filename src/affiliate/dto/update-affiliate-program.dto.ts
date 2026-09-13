/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateAffiliateProgramDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, enum: ['percentage', 'fixed'] })
  @IsOptional()
  @IsIn(['percentage', 'fixed'])
  commissionType?: 'percentage' | 'fixed';

  @ApiProperty({ required: false, example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number;

  @ApiProperty({ required: false, example: 30 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  cookieWindowDays?: number;
}
