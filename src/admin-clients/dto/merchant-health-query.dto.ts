/* eslint-disable prettier/prettier */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class MerchantHealthQueryDto {
  @ApiPropertyOptional({ enum: ['all', 'healthy', 'attention', 'at_risk'] })
  @IsOptional() @IsIn(['all', 'healthy', 'attention', 'at_risk']) band?: 'all' | 'healthy' | 'attention' | 'at_risk';

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;

  @ApiPropertyOptional({ enum: ['score', 'mrr', 'name'] })
  @IsOptional() @IsIn(['score', 'mrr', 'name']) sort?: 'score' | 'mrr' | 'name';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
