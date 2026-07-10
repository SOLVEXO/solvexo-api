/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

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
}
