/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export class SetBrandKitLockDto {
  @ApiProperty() @IsBoolean()
  locked: boolean;
}

export class UpdateBrandKitDto {
  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'primaryColor must be a hex color' })
  primaryColor: string;

  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'accentColor must be a hex color' })
  accentColor: string;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'bgColor must be a hex color' })
  bgColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'textColor must be a hex color' })
  textColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'saleColor must be a hex color' })
  saleColor?: string | null;

  @ApiProperty() @IsBoolean()
  locked: boolean;
}
