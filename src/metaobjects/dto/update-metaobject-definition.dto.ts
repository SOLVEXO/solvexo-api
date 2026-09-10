/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { FieldDefinitionInputDto } from './field-definition-input.dto';

// `type` is immutable once created (see the schema's own comment) — not
// editable here. `fieldDefinitions`, when sent, REPLACES the whole array
// (matches how the seller-facing editor always saves the complete field
// list, not a partial patch) — the service is what actually guards a real
// destructive edit (removing/retyping a field real entries already use).
export class UpdateMetaobjectDefinitionDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(60)
  name?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @ApiProperty({ required: false, type: [FieldDefinitionInputDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => FieldDefinitionInputDto)
  fieldDefinitions?: FieldDefinitionInputDto[];
}
