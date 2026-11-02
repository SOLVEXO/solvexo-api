/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty() @IsString() storeId: string;
  @ApiProperty() @IsString() registerId: string;
  @ApiProperty({ example: 'Front counter iPad' }) @IsString() @MinLength(1) @MaxLength(80) name: string;
  @ApiProperty({ required: false, example: 'ios' }) @IsOptional() @IsString() @MaxLength(30) platform?: string;
}
