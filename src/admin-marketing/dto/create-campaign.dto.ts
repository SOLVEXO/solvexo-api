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

  @ApiProperty({
    enum: ['seller', 'platform'], required: false, default: 'seller',
    description: '"seller" (default): participating sellers give the discount out of their own payout. "platform": the platform reimburses sellers, so participation costs them nothing.',
  })
  @IsOptional()
  @IsEnum(['seller', 'platform'])
  sponsorType?: 'seller' | 'platform';

  @ApiProperty({ required: false, example: 0, description: 'Rotation order in the buyer-facing deals banner when multiple campaigns are active (0 = shown first). Defaults to appended-last.' })
  @IsOptional()
  @IsNumber()
  order?: number;
}
