/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export class CreateColorSchemeDto {
  @ApiProperty() @IsString() @MaxLength(40)
  name: string;

  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'bgColor must be a hex color' })
  bgColor: string;

  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'textColor must be a hex color' })
  textColor: string;

  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'primaryColor must be a hex color' })
  primaryColor: string;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'mutedColor must be a hex color' })
  mutedColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'borderColor must be a hex color' })
  borderColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'saleColor must be a hex color' })
  saleColor?: string | null;
}
