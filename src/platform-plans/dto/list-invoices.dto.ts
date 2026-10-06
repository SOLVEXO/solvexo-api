/* eslint-disable prettier/prettier */
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Page-based pagination for the platform-plan invoice history (seller Plan & Billing + admin Clients billing tab). */
export class ListInvoicesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
  @IsOptional() @IsIn(['pending', 'paid', 'failed', 'refunded', 'partially_refunded']) status?: string;
}
