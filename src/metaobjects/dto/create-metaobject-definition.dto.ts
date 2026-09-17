/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { FieldDefinitionInputDto } from './field-definition-input.dto';

export class CreateMetaobjectDefinitionDto {
  @ApiProperty()
  @IsString() @MaxLength(40)
  @Matches(/^[a-z][a-z0-9_-]*$/, { message: 'type must start with a lowercase letter and contain only lowercase letters, numbers, - or _' })
  type: string;

  @ApiProperty() @IsString() @MaxLength(60)
  name: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @ApiProperty({ type: [FieldDefinitionInputDto] })
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => FieldDefinitionInputDto)
  fieldDefinitions: FieldDefinitionInputDto[];
}
