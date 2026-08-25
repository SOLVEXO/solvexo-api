/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBlogDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) title: string;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() commentsEnabled?: boolean;
}
