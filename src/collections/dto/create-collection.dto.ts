/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsArray, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

class CollectionRulesDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false, enum: ['all', 'any'] })
  @IsOptional()
  @IsIn(['all', 'any'])
  matchType?: 'all' | 'any';
}

export class CreateCollectionDto {
  @ApiProperty({ example: 'New Arrivals' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({ enum: ['manual', 'automatic'] })
  @IsEnum(['manual', 'automatic'])
  type: 'manual' | 'automatic';

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  @ApiProperty({ required: false, type: CollectionRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionRulesDto)
  rules?: CollectionRulesDto;
}
