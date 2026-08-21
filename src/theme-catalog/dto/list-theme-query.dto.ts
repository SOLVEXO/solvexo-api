/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { THEME_CATALOG_CATEGORIES, type ThemeCatalogCategory } from '../schemas/theme-definition.schema';

const TIER_VALUES = ['free', 'premium'] as const;

export class ListThemeQueryDto {
  @ApiProperty({ required: false, enum: THEME_CATALOG_CATEGORIES })
  @IsOptional() @IsIn(THEME_CATALOG_CATEGORIES) category?: ThemeCatalogCategory;

  @ApiProperty({ required: false, enum: TIER_VALUES })
  @IsOptional() @IsIn(TIER_VALUES) tier?: 'free' | 'premium';

  @ApiProperty({ required: false })
  @IsOptional() @IsString() search?: string;

  @ApiProperty({ required: false })
  @IsOptional() featured?: boolean;
}
