/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsDateString, IsEnum, ValidateNested, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { InPersonAddressDto } from './create-service.dto';

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class BookAppointmentDto {
  @ApiProperty({ description: 'BookableService _id to book' })
  @IsString()
  @IsNotEmpty()
  serviceId: string;

  @ApiProperty({ example: '2026-09-01' })
  @IsDateString()
  date: string;

  @ApiProperty({ example: '10:00' })
  @IsString()
  @Matches(HHMM_REGEX, { message: 'startTime must be in "HH:mm" 24h format' })
  startTime: string;

  // Not explicitly in the original spec's field list, but Booking.locationType
  // is a required schema field — defaults server-side to the service's first
  // supported location type when omitted (see BookingsService.book()).
  @ApiProperty({ required: false, enum: ['in_person', 'virtual', 'customer_address'] })
  @IsOptional()
  @IsEnum(['in_person', 'virtual', 'customer_address'])
  locationType?: string;

  @ApiProperty({ required: false, description: 'PackagePurchase _id to redeem a session from instead of paying' })
  @IsOptional()
  @IsString()
  packagePurchaseId?: string;

  @ApiProperty({ required: false, type: InPersonAddressDto, description: 'Required when locationType is "customer_address"' })
  @IsOptional()
  @ValidateNested()
  @Type(() => InPersonAddressDto)
  serviceAddress?: InPersonAddressDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  buyerNote?: string;
}
