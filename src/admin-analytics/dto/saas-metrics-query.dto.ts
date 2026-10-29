/* eslint-disable prettier/prettier */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class SaasMetricsQueryDto {
  @ApiPropertyOptional({ description: 'How many months of history (3-24)', default: 12 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(3) @Max(24)
  months?: number;
}
