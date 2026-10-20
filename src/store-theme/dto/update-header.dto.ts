/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';
import { SectionInputDto } from '../../store-pages/dto/section-input.dto';

export class UpdateHeaderDto {
  @ApiProperty({ required: false, enum: ['store', 'custom'] })
  @IsOptional() @IsIn(['store', 'custom'])
  logoSource?: 'store' | 'custom';

  @ApiProperty({ required: false })
  @IsOptional() @IsString()
  customLogoUrl?: string;

  @ApiProperty({ required: false, type: [BlockInputDto], description: 'nav_link blocks only' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  blocks?: BlockInputDto[];

  @ApiProperty({ required: false, enum: ['left', 'center', 'right'] })
  @IsOptional() @IsIn(['left', 'center', 'right'])
  navAlignment?: string;

  @ApiProperty({ required: false, enum: ['standard', 'centered', 'split', 'inline'] })
  @IsOptional() @IsIn(['standard', 'centered', 'split', 'inline'])
  headerStyle?: string;

  @ApiProperty({ required: false, nullable: true, enum: ['left', 'center', 'right'] })
  @ValidateIf((_, v) => v !== null && v !== undefined) @IsIn(['left', 'center', 'right'])
  logoPosition?: 'left' | 'center' | 'right' | null;

  @ApiProperty({ required: false, nullable: true, enum: ['beside', 'below'] })
  @ValidateIf((_, v) => v !== null && v !== undefined) @IsIn(['beside', 'below'])
  menuPosition?: 'beside' | 'below' | null;

  @ApiProperty({ required: false, nullable: true, description: 'A Menu id to render instead of `blocks` — pass null to detach and fall back to `blocks` again.' })
  @IsOptional() @IsString()
  menuId?: string | null;

  @ApiProperty({ required: false, nullable: true, description: 'Logo width in px (null = theme default)' })
  @IsOptional() @IsInt() @Min(40) @Max(400)
  logoWidth?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsInt() @Min(24) @Max(240)
  mobileLogoWidth?: number | null;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() sticky?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showSearch?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showAccount?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showWishlist?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showShopMenu?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(24) shopMenuLabel?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() includePagesInNav?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showDefaultBlogLink?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(24) blogLinkLabel?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) bgColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) textColor?: string | null;
  @ApiProperty({ required: false, enum: ['compact', 'normal', 'spacious'] }) @IsOptional() @IsIn(['compact', 'normal', 'spacious']) paddingY?: 'compact' | 'normal' | 'spacious';
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showDivider?: boolean;
  @ApiProperty({ required: false, nullable: true, enum: ['off', 'always', 'scroll-up'] }) @ValidateIf((_, v) => v !== null && v !== undefined) @IsIn(['off', 'always', 'scroll-up']) stickyMode?: 'off' | 'always' | 'scroll-up' | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() transparentOnHome?: boolean;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) transparentTextColor?: string | null;
  @ApiProperty({ required: false, enum: ['sm', 'md', 'lg'] }) @IsOptional() @IsIn(['sm', 'md', 'lg']) navFontSize?: 'sm' | 'md' | 'lg';
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() navUppercase?: boolean;
  @ApiProperty({ required: false, enum: ['none', 'underline', 'pill'] }) @IsOptional() @IsIn(['none', 'underline', 'pill']) navHoverStyle?: 'none' | 'underline' | 'pill';
  @ApiProperty({ required: false, enum: ['icon', 'bar'] }) @IsOptional() @IsIn(['icon', 'bar']) searchStyle?: 'icon' | 'bar';
  @ApiProperty({ required: false, enum: ['icons', 'center'] }) @IsOptional() @IsIn(['icons', 'center']) searchPosition?: 'icons' | 'center';
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(30) ctaLabel?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined && v !== '') @Matches(/^(https?:\/\/\S+|\/(?!\/)\S*)$/i, { message: 'Button link must start with https://, http:// or /' }) @MaxLength(500) ctaLink?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() topBarEnabled?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(120) topBarText?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) topBarPhone?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined && v !== '') @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Top bar email is not a valid address' }) @MaxLength(120) topBarEmail?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) topBarBg?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) topBarTextColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) preset?: string | null;

  @ApiProperty({ required: false, type: [SectionInputDto], description: 'Extra sections shown with the header/footer (validated per type in the service)' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SectionInputDto)
  sections?: SectionInputDto[];
}
