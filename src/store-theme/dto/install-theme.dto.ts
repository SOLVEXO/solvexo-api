/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

// The frontend theme-definition package (`builder/themes/<id>/`) is the
// single source of truth for what a theme's defaults look like — this DTO
// just carries that bundle across the wire at install time so the backend
// never needs its own copy of 12+ themes' worth of content. Mongoose casts
// each nested object against `StorefrontColors`/`StorefrontHeader`/etc on
// save, so a malformed bundle still fails validation there.
export class InstallThemeDto {
  @ApiProperty() @IsString() themeDefinitionId: string;

  @ApiProperty({ required: false }) @IsOptional() @IsObject() theme?: Record<string, unknown>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() header?: Record<string, unknown>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() footer?: Record<string, unknown>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() identityBanner?: Record<string, unknown>;
}
