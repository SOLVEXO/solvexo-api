/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * The packageId comes from the route param (`POST packages/:packageId/purchase`),
 * so nothing here is strictly required — kept as a real DTO (rather than no
 * body at all) purely so the route has somewhere to grow (e.g. a future
 * `idempotencyNote`) without a breaking change.
 */
export class PurchasePackageDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  note?: string;
}
