/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsArray, ArrayMaxSize, MaxLength, IsMongoId } from 'class-validator';

export class CreateShippingProfileDto {
  @ApiProperty({ example: 'Fragile items' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiProperty({ required: false, type: [String], description: 'StoreLocation ids that ship this profile (first = Shippo / radius origin)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  originLocationIds?: string[];
}

export class UpdateShippingProfileDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsMongoId({ each: true })
  originLocationIds?: string[];
}

export class AssignProfileProductsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  productIds: string[];
}
