/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCustomCssDto {
  @ApiProperty({ required: false, description: 'Raw CSS injected into the storefront — real, bounded developer/advanced authoring capability. Null/omitted clears it.' })
  @IsOptional() @IsString() @MaxLength(20_000)
  customCss?: string | null;
}
