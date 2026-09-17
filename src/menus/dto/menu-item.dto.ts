/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MENU_LINK_TYPES, type MenuLinkType } from '../schemas/menu.schema';

export class MenuItemChildDto {
  @ApiProperty() @IsString() id: string;
  @ApiProperty() @IsString() @MaxLength(40) label: string;
  @ApiProperty({ enum: MENU_LINK_TYPES }) @IsIn(MENU_LINK_TYPES) linkType: MenuLinkType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pageSlug?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() url?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() categoryId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() collectionId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() highlight?: boolean;
}

export class MenuItemDto {
  @ApiProperty() @IsString() id: string;
  @ApiProperty() @IsString() @MaxLength(40) label: string;
  @ApiProperty({ enum: MENU_LINK_TYPES }) @IsIn(MENU_LINK_TYPES) linkType: MenuLinkType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() pageSlug?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() url?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() categoryId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() collectionId?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() highlight?: boolean;
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
