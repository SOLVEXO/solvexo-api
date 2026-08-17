/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsIn, IsOptional, IsBoolean } from 'class-validator';

export class CreateRedirectDto {
  @ApiProperty({ example: '/old-product-slug' })
  @IsString()
  @IsNotEmpty()
  source: string;

  @ApiProperty({ example: '/new-product-slug' })
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ enum: [301, 302], required: false, default: 301 })
  @IsOptional()
  @IsIn([301, 302])
  statusCode?: number;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
