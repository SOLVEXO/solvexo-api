import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class PosPurchaseQueryDto {
  @ApiProperty({
    required: false,
    description: 'Matches against seller or store name',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ enum: ['active', 'expired'], required: false })
  @IsOptional()
  @IsEnum(['active', 'expired'])
  status?: string;

  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
