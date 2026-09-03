/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

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
}
