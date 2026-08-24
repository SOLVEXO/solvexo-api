/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class SubmitCommentDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(80) authorName: string;

  @ApiProperty() @IsEmail() authorEmail: string;

  @ApiProperty() @IsString() @MinLength(1) @MaxLength(2000) body: string;
}
