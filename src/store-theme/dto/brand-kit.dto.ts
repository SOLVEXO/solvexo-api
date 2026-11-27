/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export class SetBrandKitLockDto {

  @ApiProperty() @IsBoolean()
  locked: boolean;
}

const RADIUS = ['none', 'small', 'medium', 'large', 'full'] as const;

/** The theme settings a Brand Kit can drive besides the five core colours. Each is optional: absent / null = the theme keeps its own value. */
export const BRAND_KIT_EXTRA_COLOR_KEYS = ['linkColor', 'priceColor', 'starColor', 'headingColor', 'buttonTextColor', 'cardBgColor'] as const;
export const BRAND_KIT_EXTRA_STYLE_KEYS = [
  'font', 'headingFont', 'headingWeight', 'headingCase', 'headingTracking', 'buttonCase',
  'buttonStyle', 'buttonRadius', 'imageRadius', 'sectionRadius', 'inputRadius', 'productCardRadius', 'buttonHover', 'buttonShadow', 'cardHover',
] as const;

export class UpdateBrandKitDto {
  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'primaryColor must be a hex color' })
  primaryColor: string;

  @ApiProperty() @IsString() @Matches(HEX_COLOR, { message: 'accentColor must be a hex color' })
  accentColor: string;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'bgColor must be a hex color' })
  bgColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'textColor must be a hex color' })
  textColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'saleColor must be a hex color' })
  saleColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'linkColor must be a hex color' }) linkColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'priceColor must be a hex color' }) priceColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'starColor must be a hex color' }) starColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'headingColor must be a hex color' }) headingColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'buttonTextColor must be a hex color' }) buttonTextColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @Matches(HEX_COLOR, { message: 'cardBgColor must be a hex color' }) cardBgColor?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(80) font?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(80) headingFont?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['regular', 'medium', 'semibold', 'bold']) headingWeight?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['none', 'uppercase']) headingCase?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['auto', 'tight', 'normal', 'wide']) headingTracking?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['normal', 'uppercase']) buttonCase?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['solid', 'outline', 'soft']) buttonStyle?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(RADIUS) buttonRadius?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(RADIUS) imageRadius?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['none', 'small', 'medium', 'large']) sectionRadius?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(RADIUS) inputRadius?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(RADIUS) productCardRadius?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['fade', 'lift', 'grow']) buttonHover?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['none', 'soft']) buttonShadow?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsIn(['shadow', 'lift', 'none']) cardHover?: string | null;

  /** Which style preset the seller started from (informational, shown selected in the Brand Kit page). */
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) presetId?: string | null;

  @ApiProperty() @IsBoolean()
  locked: boolean;
}
