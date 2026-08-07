/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString } from 'class-validator';

/** Loose shell DTO for a `Block` — `type` picks which allow-list applies, `settings` is validated per-type imperatively in the owning service (see `section-settings.validator.ts`), not via class-validator, since the shape genuinely differs by type. Shared across `store-theme` (header/footer blocks) and `store-pages` (section blocks). */
export class BlockInputDto {
  @ApiProperty() @IsString() type: string;
  @ApiProperty({ type: Object }) @IsObject() settings: Record<string, any>;
}
