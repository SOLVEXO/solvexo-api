/* eslint-disable prettier/prettier */
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMediaAssetDto {
  @IsOptional() @IsString() @MaxLength(300)
  altText?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];
}
