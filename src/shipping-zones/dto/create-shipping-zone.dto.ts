/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, Min, IsEnum } from 'class-validator';

export class CreateShippingZoneDto {
  @ApiProperty({ example: 'Pakistan' })
  @IsString()
  @IsNotEmpty()
  country: string;

  @ApiProperty({ required: false, example: 'Punjab' })
  @IsOptional()
  @IsString()
  province?: string;

  @ApiProperty({ required: false, example: 'Lahore' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ example: 250 })
  @IsNumber()
  @Min(0)
  shippingPrice: number;

  @ApiProperty({ required: false, example: '3-5 Days' })
  @IsOptional()
  @IsString()
  estimatedDeliveryTime?: string;

  @ApiProperty({ required: false, enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: 'active' | 'inactive';
}
