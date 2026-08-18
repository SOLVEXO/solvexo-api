/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsNumber, IsInt,
  IsPositive, Min, IsArray, IsEnum, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { InPersonAddressDto } from './create-service.dto';

export class UpdateServiceDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  durationMinutes?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacityPerSlot?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cancellationWindowHours?: number;

  @ApiProperty({ required: false, type: [String], enum: ['in_person', 'virtual', 'customer_address'] })
  @IsOptional()
  @IsArray()
  @IsEnum(['in_person', 'virtual', 'customer_address'], { each: true })
  locationTypes?: string[];

  @ApiProperty({ required: false, type: InPersonAddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => InPersonAddressDto)
  inPersonAddress?: InPersonAddressDto;

  @ApiProperty({ required: false, enum: ['active', 'inactive', 'draft'] })
  @IsOptional()
  @IsEnum(['active', 'inactive', 'draft'])
  status?: string;
}
