/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsString, MaxLength, ValidateNested } from 'class-validator';

class EntryFieldInput {
  @ApiProperty() @IsString() key: string;
  // Validated for real against the matching field definition's `type` in
  // the service — see `MetaobjectsService.upsertEntry`, same
  // "class-validator can't know the definition, the service checks it for
  // real" pattern `SetValuesDto` already uses for Metafields.
  @ApiProperty() @IsString() value: string;
}

export class SetEntryFieldsDto {
  @ApiProperty() @IsString() @MaxLength(150)
  displayName: string;

  @ApiProperty({ type: [EntryFieldInput] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => EntryFieldInput)
  fields: EntryFieldInput[];
}
