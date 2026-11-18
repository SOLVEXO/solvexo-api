/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// `type`/`key`/`ownerResource` are immutable once created — changing a
// definition's data type after real `MetafieldValue` rows exist against it
// would leave those rows holding a string no longer parseable as the new
// type, and changing `key`/`ownerResource` would orphan them outright. Only
// the display-facing fields are editable; delete + recreate covers the rest.
export class UpdateDefinitionDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(60)
  name?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  required?: boolean;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  storefrontAccess?: boolean;

  /** Empty array = every product. */
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(60, { each: true })
  categoryIds?: string[];
}
