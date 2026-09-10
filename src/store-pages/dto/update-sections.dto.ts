/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { SectionInputDto } from './section-input.dto';

/** Whole-array rewrite — add/remove/reorder a page's sections all go through this one endpoint, since the array (not a per-section id) is the unit of authorship from the builder. */
export class UpdateSectionsDto {
  @ApiProperty({ type: [SectionInputDto] })
  @IsArray() @ValidateNested({ each: true }) @Type(() => SectionInputDto)
  sections: SectionInputDto[];
}
