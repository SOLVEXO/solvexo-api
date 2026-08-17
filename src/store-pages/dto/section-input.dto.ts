/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsObject, ValidateNested } from 'class-validator';
import { SECTION_TYPES, SectionType } from '../../common/schemas/section.schema';
import { BlockInputDto } from '../../common/dto/block-input.dto';

/** Loose shell DTO for a `Section` — `settings`/`blocks` are validated per-`type` imperatively in the service (see `section-settings.validator.ts`). */
export class SectionInputDto {
  @ApiProperty({ enum: SECTION_TYPES }) @IsIn(SECTION_TYPES) type: SectionType;
  @ApiProperty({ type: Object }) @IsObject() settings: Record<string, any>;
  @ApiProperty({ type: [BlockInputDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto) blocks: BlockInputDto[];
}
