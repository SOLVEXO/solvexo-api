/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsOptional, IsNumber, IsInt,
  IsPositive, Min, IsArray, IsEnum, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InPersonAddressDto {
  @ApiProperty({ example: '123 Main St' })
  @IsString()
  @IsNotEmpty()
  addressLine1: string;

  @ApiProperty({ example: 'Karachi' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiProperty({ example: '+92 300 1234567' })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class CreateServiceDto {
  @ApiProperty({ example: '60-Minute Consultation' })
  @IsString()
  @IsNotEmpty()
  name: string;

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

  @ApiProperty({ example: 60, description: 'Length of one appointment slot, in minutes' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  durationMinutes: number;

  @ApiProperty({ example: 49.99 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price: number;

  @ApiProperty({ required: false, default: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ required: false, default: 1, description: 'How many buyers can book the same time slot' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacityPerSlot?: number;

  @ApiProperty({ required: false, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cancellationWindowHours?: number;

  @ApiProperty({ type: [String], enum: ['in_person', 'virtual', 'customer_address'] })
  @IsArray()
  @IsEnum(['in_person', 'virtual', 'customer_address'], { each: true })
  locationTypes: string[];

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
