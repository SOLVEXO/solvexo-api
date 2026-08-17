/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreateCanonicalRuleDto {
  @ApiProperty({ example: '/marketplace/category/:id' })
  @IsString()
  @IsNotEmpty()
  pathPattern: string;

  @ApiProperty({ example: 'https://solvexo.store/marketplace/category/electronics' })
  @IsString()
  @IsNotEmpty()
  canonicalUrl: string;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
