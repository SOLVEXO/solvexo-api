/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreatePageDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) title: string;

  @ApiProperty({ description: 'Lowercase, hyphenated — served at /:slug/pages/:slug' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' })
  @MaxLength(80)
  slug: string;
}
