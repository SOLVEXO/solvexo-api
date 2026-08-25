/* eslint-disable prettier/prettier */
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListMediaAssetsDto {
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsIn(['image', 'video'])
  type?: 'image' | 'video';

  @IsOptional() @IsString()
  tag?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}
