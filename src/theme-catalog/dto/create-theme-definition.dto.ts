/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { THEME_CATALOG_CATEGORIES, type ThemeCatalogCategory } from '../schemas/theme-definition.schema';

const TIER_VALUES = ['free', 'premium'] as const;
const BADGE_VALUES = ['new', 'popular', 'trending'] as const;

/**
 * `theme`/`header`/`footer`/`identityBanner` are accepted as loose objects
 * here (not re-declaring every one of the ~24+40 fields class-validator
 * already validates on `UpdateThemeDto`/`UpdateHeaderDto`/`UpdateFooterDto`/
 * `UpdateIdentityBannerDto`) — Mongoose's own schema (enum-locked, reused
 * verbatim from `store-theme.schema.ts`) rejects an invalid enum value at
 * save time, and `homePageSections` is validated explicitly in
 * `ThemeCatalogService` via the same `validateSectionSettings`/
 * `validateBlockSettings` every seller-authored page already goes through.
 */
export class CreateThemeDefinitionDto {
  @ApiProperty() @IsString() @MaxLength(60) slug: string;
  @ApiProperty() @IsString() @MaxLength(80) name: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(400) description?: string;
  @ApiProperty({ enum: THEME_CATALOG_CATEGORIES }) @IsIn(THEME_CATALOG_CATEGORIES) category: ThemeCatalogCategory;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() tags?: string[];
  @ApiProperty({ required: false }) @IsOptional() @IsString() thumbnail?: string;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() screenshots?: string[];
  @ApiProperty({ required: false, enum: TIER_VALUES }) @IsOptional() @IsIn(TIER_VALUES) tier?: 'free' | 'premium';
  @ApiProperty({ required: false, enum: BADGE_VALUES, nullable: true }) @IsOptional() @IsIn(BADGE_VALUES) badge?: 'new' | 'popular' | 'trending' | null;

  @ApiProperty({ required: false }) @IsOptional() theme?: Record<string, any>;
  @ApiProperty({ required: false }) @IsOptional() header?: Record<string, any>;
  @ApiProperty({ required: false }) @IsOptional() footer?: Record<string, any>;
  @ApiProperty({ required: false }) @IsOptional() identityBanner?: Record<string, any>;
  @ApiProperty({ required: false, type: [Object] }) @IsOptional() @IsArray() homePageSections?: Record<string, any>[];
}
