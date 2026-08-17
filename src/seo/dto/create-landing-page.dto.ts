/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject, IsIn } from 'class-validator';

export class CreateLandingPageDto {
  @ApiProperty({ example: 'summer-sale-2026' })
  @IsString() @IsNotEmpty()
  slug: string;

  @ApiProperty({ example: 'Summer Sale 2026' })
  @IsString() @IsNotEmpty()
  title: string;

  @ApiProperty({ required: false })
  @IsOptional() @IsObject()
  content?: Record<string, any>;

  @ApiProperty({ required: false, enum: ['draft', 'published'], default: 'draft' })
  @IsOptional() @IsIn(['draft', 'published'])
  status?: string;
}
