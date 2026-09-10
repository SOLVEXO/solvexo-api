/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { METAFIELD_OWNER_RESOURCES, METAFIELD_TYPES, type MetafieldOwnerResource, type MetafieldType } from '../schemas/metafield-definition.schema';

export class CreateDefinitionDto {
  @ApiProperty({ enum: METAFIELD_OWNER_RESOURCES })
  @IsIn(METAFIELD_OWNER_RESOURCES)
  ownerResource: MetafieldOwnerResource;

  // Lowercase/dash-or-underscore only, same shape convention `generateSlug`
  // uses elsewhere in this codebase — this is a stable machine identifier,
  // not display text.
  @ApiProperty()
  @IsString() @MaxLength(40)
  @Matches(/^[a-z][a-z0-9_-]*$/, { message: 'key must start with a lowercase letter and contain only lowercase letters, numbers, - or _' })
  key: string;

  @ApiProperty() @IsString() @MaxLength(60)
  name: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200)
  description?: string;

  @ApiProperty({ enum: METAFIELD_TYPES })
  @IsIn(METAFIELD_TYPES)
  type: MetafieldType;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  required?: boolean;
}
