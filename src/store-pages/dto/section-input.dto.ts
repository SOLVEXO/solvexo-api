/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { SECTION_TYPES, SectionType } from '../../common/schemas/section.schema';
import { BlockInputDto } from '../../common/dto/block-input.dto';

/**
 * Loose shell DTO for a `Section` — `settings`/`blocks` are validated per-`type` imperatively in the service (see `section-settings.validator.ts`).
 *
 * `_id`/`enabled`/`schemaVersion` are declared for the same reason as on
 * `BlockInputDto` — a real `ValidationPipe({ whitelist: true })` now runs
 * against this DTO, and an undeclared field is silently stripped, not just
 * ignored.
 */
export class SectionInputDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() _id?: string;
  @ApiProperty({ enum: SECTION_TYPES }) @IsIn(SECTION_TYPES) type: SectionType;
  @ApiProperty({ type: Object }) @IsObject() settings: Record<string, any>;
  @ApiProperty({ type: [BlockInputDto] }) @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto) blocks: BlockInputDto[];
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() schemaVersion?: number;
}
