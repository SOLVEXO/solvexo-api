/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { METAFIELD_TYPES, type MetafieldType } from '../../metafields/schemas/metafield-definition.schema';

export class FieldDefinitionInputDto {
  @ApiProperty()
  @IsString() @MaxLength(40)
  @Matches(/^[a-z][a-z0-9_-]*$/, { message: 'key must start with a lowercase letter and contain only lowercase letters, numbers, - or _' })
  key: string;

  @ApiProperty() @IsString() @MaxLength(60)
  name: string;

  @ApiProperty({ enum: METAFIELD_TYPES })
  @IsIn(METAFIELD_TYPES)
  type: MetafieldType;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  required?: boolean;
}
