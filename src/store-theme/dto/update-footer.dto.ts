/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { BlockInputDto } from '../../common/dto/block-input.dto';
import { SectionInputDto } from '../../store-pages/dto/section-input.dto';

export class UpdateFooterDto {
  @ApiProperty({ type: [BlockInputDto], description: 'footer_column / social_link / copyright_text blocks' })
  @IsArray() @ValidateNested({ each: true }) @Type(() => BlockInputDto)
  blocks: BlockInputDto[];

  @ApiProperty({ required: false, enum: ['columns', 'minimal'] })
  @IsOptional() @IsIn(['columns', 'minimal'])
  footerStyle?: string;

  @ApiProperty({ required: false, nullable: true, description: "A Menu id whose items become one synthetic footer_column block (heading = the menu's name) alongside the footer's own social_link/copyright_text blocks — pass null to detach." })
  @IsOptional() @IsString()
  menuId?: string | null;

  @ApiProperty({ required: false, enum: ['none', 'store', 'custom'] })
  @IsOptional() @IsIn(['none', 'store', 'custom'])
  logoSource?: 'none' | 'store' | 'custom';

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(2048) logoUrl?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional() @IsInt() @Min(40) @Max(400)
  logoWidth?: number | null;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showNewsletter?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(60) newsletterHeading?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(160) newsletterText?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showDefaultColumns?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) shopColumnHeading?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) accountColumnHeading?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(24) blogLinkLabel?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) bgColor?: string | null;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined) @Matches(/^#[0-9a-fA-F]{6}$/) textColor?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() blockLayout?: boolean;
  @ApiProperty({ required: false, enum: ['compact', 'normal', 'spacious'] }) @IsOptional() @IsIn(['compact', 'normal', 'spacious']) paddingY?: 'compact' | 'normal' | 'spacious';
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== null && v !== undefined && v !== '') @Matches(/^https:\/\//i, { message: 'Background image must be an https:// URL' }) @MaxLength(2048) bgImageUrl?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(0) @Max(85) bgOverlay?: number;
  @ApiProperty({ required: false, enum: ['left', 'center'] }) @IsOptional() @IsIn(['left', 'center']) align?: 'left' | 'center';
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() headingUppercase?: boolean;
  @ApiProperty({ required: false, nullable: true, enum: ['plain', 'circle', 'square'] }) @ValidateIf((_, v) => v !== null && v !== undefined) @IsIn(['plain', 'circle', 'square']) socialStyle?: 'plain' | 'circle' | 'square' | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() newsletterTop?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() mobileAccordion?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showPolicyLinks?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showCurrency?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showBackToTop?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) preset?: string | null;

  @ApiProperty({ required: false, type: [SectionInputDto], description: 'Extra sections shown with the header/footer (validated per type in the service)' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SectionInputDto)
  sections?: SectionInputDto[];
}
