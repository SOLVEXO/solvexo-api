/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateBlogPostDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(120) title?: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsString() @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' }) @MaxLength(100)
  slug?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(240) excerpt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() coverImage?: string;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() tags?: string[];
}
