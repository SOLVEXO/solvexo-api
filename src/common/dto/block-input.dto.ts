/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Loose shell DTO for a `Block` — `type` picks which allow-list applies, `settings` is validated per-type imperatively in the owning service (see `section-settings.validator.ts`), not via class-validator, since the shape genuinely differs by type. Shared across `store-theme` (header/footer blocks) and `store-pages` (section blocks).
 *
 * `_id`/`enabled`/`schemaVersion` must be declared here (even though nothing
 * validates their *content* beyond type) now that controllers run a real
 * `ValidationPipe({ whitelist: true })` — without them, whitelist stripping
 * would silently discard a block's identity and hide/show state on every
 * save. `_id` is optional because a brand-new block (not yet persisted)
 * won't have one yet; Mongoose assigns it on insert.
 */
export class BlockInputDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() _id?: string;
  @ApiProperty() @IsString() type: string;
  @ApiProperty({ type: Object }) @IsObject() settings: Record<string, any>;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() schemaVersion?: number;
}
