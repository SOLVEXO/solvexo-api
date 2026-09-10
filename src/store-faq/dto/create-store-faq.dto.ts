/* eslint-disable prettier/prettier */
import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateStoreFaqDto {
  @ApiProperty({ example: 'Do you ship internationally?' })
  @IsString()
  @IsNotEmpty({ message: 'Question is required' })
  question: string;

  @ApiProperty({ example: 'Yes, we ship to most countries within 5-10 business days.' })
  @IsString()
  @IsNotEmpty({ message: 'Answer is required' })
  answer: string;

  @ApiProperty({ required: false, example: 0, description: 'Display order (lower numbers appear first)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  order?: number;

  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateStoreFaqDto extends PartialType(CreateStoreFaqDto) {}
