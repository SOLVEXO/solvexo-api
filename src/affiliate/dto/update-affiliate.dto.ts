/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateAffiliateDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, enum: ['percentage', 'fixed', null] })
  @IsOptional()
  @IsIn(['percentage', 'fixed', null])
  commissionType?: 'percentage' | 'fixed' | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number | null;
}
