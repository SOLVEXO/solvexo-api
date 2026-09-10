/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
