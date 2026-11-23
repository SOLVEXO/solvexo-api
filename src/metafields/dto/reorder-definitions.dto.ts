/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsString } from 'class-validator';
import { METAFIELD_OWNER_RESOURCES, type MetafieldOwnerResource } from '../schemas/metafield-definition.schema';

/** The new order of a resource's fields: every definition id, first to last. */
export class ReorderDefinitionsDto {
  @ApiProperty({ enum: METAFIELD_OWNER_RESOURCES })
  @IsIn(METAFIELD_OWNER_RESOURCES)
  ownerResource: MetafieldOwnerResource;

  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(500) @IsString({ each: true })
  ids: string[];
}
