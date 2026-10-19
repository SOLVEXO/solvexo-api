/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsHexColor, IsIn, IsOptional, IsString } from 'class-validator';

const BORDER_RADIUS_VALUES = ['none', 'small', 'medium', 'large', 'full'] as const;
const BUTTON_STYLE_VALUES = ['solid', 'outline', 'soft'] as const;
const BUTTON_WIDTH_VALUES = ['auto', 'full'] as const;
const SCALE_VALUES = ['compact', 'comfortable', 'spacious'] as const;
const CONTAINER_WIDTH_VALUES = ['narrow', 'standard', 'wide'] as const;
const CARD_STYLE_VALUES = ['flat', 'outlined', 'elevated'] as const;
const BUTTON_SIZE_VALUES = ['sm', 'md', 'lg'] as const;
const HERO_STYLE_VALUES = ['overlay', 'split'] as const;
const HERO_ALIGNMENT_VALUES = ['left', 'center'] as const;
const PRODUCT_IMAGE_RATIO_VALUES = ['square', 'portrait', 'landscape', 'adapt'] as const;
const PRODUCT_IMAGE_HOVER_VALUES = ['none', 'zoom', 'second-image'] as const;
const PRODUCT_GRID_DENSITY_VALUES = ['cozy', 'relaxed'] as const;
const TESTIMONIAL_STYLE_VALUES = ['cards', 'minimal'] as const;
const FAQ_STYLE_VALUES = ['accordion', 'list'] as const;

export class UpdateThemeDto {
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() primaryColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() bgColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() textColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsHexColor() accentColor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() font?: string;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() headingFont?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() mutedColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() borderColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() saleColor?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['regular', 'medium', 'semibold', 'bold']) headingWeight?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['none', 'uppercase']) headingCase?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['auto', 'tight', 'normal', 'wide']) headingTracking?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['normal', 'uppercase']) buttonCase?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['none', 'small', 'medium', 'large']) sectionRadius?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['none', 'small', 'medium', 'large', 'full']) inputRadius?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['pill', 'square']) badgeStyle?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) cardRating?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) cardTag?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) cardButton?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['small', 'medium', 'large', 'xlarge']) headingScale?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['small', 'medium', 'large']) bodyScale?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['auto', 'tight', 'normal', 'loose']) headingLineHeight?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['auto', 'always', 'never']) linkUnderline?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['narrow', 'standard', 'wide']) pagePadding?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['tight', 'standard', 'airy']) gridGap?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['fade', 'lift', 'grow']) buttonHover?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['none', 'soft']) buttonShadow?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['shadow', 'lift', 'none']) cardHover?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['left', 'center']) cardTextAlign?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) showBreadcrumbs?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) showStockStatus?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) showVendor?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) showReviews?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) stickyBuyBar?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['on', 'off']) animations?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['auto', 'accent', 'ink']) focusRing?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['regular', 'medium']) bodyWeight?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['none', 'line']) sectionDividers?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['auto', 'accent']) selection?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) cardWishlist?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) cardViewLink?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['percent', 'label']) saleBadgeText?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsIn(['show', 'hide']) showDelivery?: string;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() headingColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() linkColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() priceColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() starColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() successColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() buttonTextColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsHexColor() cardBgColor?: string | null;
  @ApiProperty({ required: false, enum: BUTTON_STYLE_VALUES }) @IsOptional() @IsIn(BUTTON_STYLE_VALUES) buttonStyle?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) buttonRadius?: string;
  @ApiProperty({ required: false, enum: BUTTON_WIDTH_VALUES }) @IsOptional() @IsIn(BUTTON_WIDTH_VALUES) buttonWidth?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) imageRadius?: string;

  @ApiProperty({ required: false, enum: SCALE_VALUES }) @IsOptional() @IsIn(SCALE_VALUES) typeScale?: string;
  @ApiProperty({ required: false, enum: CONTAINER_WIDTH_VALUES }) @IsOptional() @IsIn(CONTAINER_WIDTH_VALUES) containerWidth?: string;
  @ApiProperty({ required: false, enum: SCALE_VALUES }) @IsOptional() @IsIn(SCALE_VALUES) sectionSpacing?: string;
  @ApiProperty({ required: false, enum: CARD_STYLE_VALUES }) @IsOptional() @IsIn(CARD_STYLE_VALUES) productCardStyle?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) productCardRadius?: string;
  @ApiProperty({ required: false, enum: BUTTON_SIZE_VALUES }) @IsOptional() @IsIn(BUTTON_SIZE_VALUES) buttonSize?: string;
  @ApiProperty({ required: false, enum: HERO_STYLE_VALUES }) @IsOptional() @IsIn(HERO_STYLE_VALUES) heroStyle?: string;
  @ApiProperty({ required: false, enum: HERO_ALIGNMENT_VALUES }) @IsOptional() @IsIn(HERO_ALIGNMENT_VALUES) heroAlignment?: string;
  @ApiProperty({ required: false, enum: PRODUCT_IMAGE_RATIO_VALUES }) @IsOptional() @IsIn(PRODUCT_IMAGE_RATIO_VALUES) productImageRatio?: string;
  @ApiProperty({ required: false, enum: PRODUCT_IMAGE_HOVER_VALUES }) @IsOptional() @IsIn(PRODUCT_IMAGE_HOVER_VALUES) productImageHover?: string;
  @ApiProperty({ required: false, enum: PRODUCT_GRID_DENSITY_VALUES }) @IsOptional() @IsIn(PRODUCT_GRID_DENSITY_VALUES) productGridDensity?: string;
  @ApiProperty({ required: false, enum: TESTIMONIAL_STYLE_VALUES }) @IsOptional() @IsIn(TESTIMONIAL_STYLE_VALUES) testimonialStyle?: string;
  @ApiProperty({ required: false, enum: CARD_STYLE_VALUES }) @IsOptional() @IsIn(CARD_STYLE_VALUES) testimonialCardStyle?: string;
  @ApiProperty({ required: false, enum: BORDER_RADIUS_VALUES }) @IsOptional() @IsIn(BORDER_RADIUS_VALUES) testimonialCardRadius?: string;
  @ApiProperty({ required: false, enum: FAQ_STYLE_VALUES }) @IsOptional() @IsIn(FAQ_STYLE_VALUES) faqStyle?: string;
  // Shopify-style theme settings: product card badges, card style, cart type.
  @ApiProperty({ required: false, enum: ['show', 'hide'] }) @IsOptional() @IsIn(['show', 'hide']) saleBadge?: string;
  @ApiProperty({ required: false, enum: ['show', 'hide'] }) @IsOptional() @IsIn(['show', 'hide']) quickView?: string;
  @ApiProperty({ required: false, enum: ['show', 'hide'] }) @IsOptional() @IsIn(['show', 'hide']) colorSwatches?: string;
  @ApiProperty({ required: false, enum: ['show', 'hide'] }) @IsOptional() @IsIn(['show', 'hide']) soldOutBadge?: string;
  @ApiProperty({ required: false, enum: ['theme', 'flat', 'outlined', 'elevated'] }) @IsOptional() @IsIn(['theme', 'flat', 'outlined', 'elevated']) cardStyle?: string;
  @ApiProperty({ required: false, enum: ['drawer', 'page'] }) @IsOptional() @IsIn(['drawer', 'page']) cartType?: string;

  // Set when this update came from applying a curated theme (frontend
  // `themes.ts` id, not a backend ref) — null/omitted clears/leaves it alone.
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() baseThemeId?: string | null;
}
