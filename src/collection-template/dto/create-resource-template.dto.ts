/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateResourceTemplateDto {
  @ApiProperty() @IsString() @MaxLength(60)
  name: string;

  // Stable identifier — slugified server-side (see service). e.g. "Sale
  // Collection" -> "sale-collection". A Product/Collection assigns this via
  // its own `templateKey` field, so it never changes once other resources
  // reference it.
  @ApiProperty() @IsString() @MaxLength(60)
  templateKey: string;

  @ApiProperty({ required: false, description: 'Start from a copy of this existing template instead of the blank starter' })
  @IsOptional() @IsString()
  cloneFromTemplateKey?: string;
}
