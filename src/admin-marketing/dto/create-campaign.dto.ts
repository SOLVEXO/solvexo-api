/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateCampaignDto {
  @ApiProperty({ example: 'Summer Sale Weekend' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  bannerImage?: string;

  @ApiProperty({ example: '2026-08-01T00:00:00.000Z' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2026-08-03T23:59:59.000Z' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ enum: ['percentage', 'fixed'], required: false })
  @IsOptional()
  @IsEnum(['percentage', 'fixed'])
  discountType?: 'percentage' | 'fixed';

  @ApiProperty({ required: false, example: 20 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountValue?: number;
}
