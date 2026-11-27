/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MENU_LINK_TYPES, MENU_STYLES, type MenuLinkType, type MenuStyle } from '../schemas/menu.schema';

export class MenuItemChildDto {
  @ApiProperty() @IsString() id: string;
  @ApiProperty() @IsString() @MaxLength(40) label: string;
  @ApiProperty({ enum: MENU_LINK_TYPES }) @IsIn(MENU_LINK_TYPES) linkType: MenuLinkType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pageSlug?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() url?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() categoryId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() collectionId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() productId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() highlight?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() newTab?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(12) badge?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(7) badgeColor?: string | null;
  @ApiProperty({ required: false, description: 'No-code Style of this link (validated like a block style)' }) @IsOptional() @IsObject() style?: Record<string, any> | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(12) showTo?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(40) showFrom?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(40) showUntil?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) showCountries?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) hideCountries?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(100) showLanguages?: string | null;
  @ApiProperty({ type: [MenuItemChildDto], required: false })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MenuItemChildDto)
  children?: MenuItemChildDto[];
}

export class MenuItemDto {
  @ApiProperty() @IsString() id: string;
  @ApiProperty({ required: false, enum: MENU_STYLES }) @IsOptional() @IsIn(MENU_STYLES) menuStyle?: MenuStyle;
  @ApiProperty() @IsString() @MaxLength(40) label: string;
  @ApiProperty({ enum: MENU_LINK_TYPES }) @IsIn(MENU_LINK_TYPES) linkType: MenuLinkType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pageSlug?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() url?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() categoryId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() collectionId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() productId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() highlight?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() newTab?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(12) badge?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(7) badgeColor?: string | null;
  @ApiProperty({ required: false, description: 'No-code Style of this link (validated like a block style)' }) @IsOptional() @IsObject() style?: Record<string, any> | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(12) showTo?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(40) showFrom?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(40) showUntil?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) showCountries?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) hideCountries?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(100) showLanguages?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(0) @Max(6) megaColumns?: number;
  @ApiProperty({ required: false, type: 'array', items: { type: 'object' } }) @IsOptional() @IsArray() @ArrayMaxSize(2) @IsObject({ each: true }) megaPromos?: Record<string, any>[];
  @ApiProperty({ type: [MenuItemChildDto], required: false })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MenuItemChildDto)
  children?: MenuItemChildDto[];
}

export class CreateMenuDto {
  @ApiProperty() @IsString() @MaxLength(60)
  name: string;

  @ApiProperty({ type: [MenuItemDto], required: false })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MenuItemDto)
  items?: MenuItemDto[];
}

export class UpdateMenuDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(60)
  name?: string;

  @ApiProperty({ type: [MenuItemDto], required: false })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MenuItemDto)
  items?: MenuItemDto[];
}
