/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateBlogPostDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(120) title: string;

  @ApiProperty({ description: 'Lowercase, hyphenated — served at /:slug/blog/:slug' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'slug must be lowercase letters, numbers, and hyphens only' })
  @MaxLength(100)
  slug: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(240) excerpt?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() coverImage?: string;
  @ApiProperty({ required: false, description: 'Which Blog this post belongs to — omit to use the store\'s default blog.' })
  @IsOptional() @IsString() blogId?: string;
}
