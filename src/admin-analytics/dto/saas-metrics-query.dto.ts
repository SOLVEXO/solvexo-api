/* eslint-disable prettier/prettier */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class SaasMetricsQueryDto {
  @ApiPropertyOptional({ description: 'How many months of history (SaaS metrics: 3-24; activation funnel: 1-24)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24)
  months?: number;
}
