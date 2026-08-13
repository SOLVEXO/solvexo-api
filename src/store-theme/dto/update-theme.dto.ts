/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsHexColor, IsOptional, IsString } from 'class-validator';

export class UpdateThemeDto {
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() primaryColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() bgColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() textColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() accentColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() font?: string;
}
