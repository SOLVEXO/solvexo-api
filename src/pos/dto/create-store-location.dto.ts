/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsIn, IsNumber, Min, Max, MaxLength } from 'class-validator';

export class CreateStoreLocationDto {
  @ApiProperty({ example: 'North Karachi' })
  @IsString() @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  addressLine1?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  city?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(200)
  addressLine2?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(100)
  state?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @MaxLength(20)
  zipCode?: string;

  @ApiProperty({ required: false, description: 'ISO-3166 alpha-2 (e.g. PK, US)' })
  @IsOptional() @IsString() @MaxLength(60)
  country?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number | null;

  @ApiProperty({ required: false, enum: ['store', 'warehouse'], default: 'store' })
  @IsOptional() @IsIn(['store', 'warehouse'])
  type?: 'store' | 'warehouse';
}
