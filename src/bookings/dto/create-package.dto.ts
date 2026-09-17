/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsInt, IsPositive } from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePackageDto {
  @ApiProperty({ example: '5-Session Pack' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 5 })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  sessionsCount: number;

  @ApiProperty({ example: 199.99 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  price: number;

  @ApiProperty({ required: false, default: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ example: 90, description: 'Days after purchase before unused sessions expire' })
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  validityDays: number;
}
