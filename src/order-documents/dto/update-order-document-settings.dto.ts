/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { DOC_ALIGNS, DOC_PAPER_SIZES, DOC_SIZES, WATERMARK_ANGLES, WATERMARK_POSITIONS, WATERMARK_TYPES } from '../schemas/order-document-settings.schema';

/** Every field optional (PATCH). '' or null on a text field clears it back to the default. */
export class UpdateOrderDocumentSettingsDto {
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(80) companyName?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(300) addressText?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @ApiProperty({ required: false, nullable: true })
  @ValidateIf((o) => o.email !== undefined && o.email !== null && o.email !== '') @IsEmail() @MaxLength(200) email?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(30) taxIdLabel?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(60) taxIdValue?: string | null;

  @ApiProperty({ required: false, enum: DOC_PAPER_SIZES }) @IsOptional() @IsIn([...DOC_PAPER_SIZES]) paperSize?: string;
  @ApiProperty({ required: false, nullable: true })
  @ValidateIf((o) => o.accentColor !== undefined && o.accentColor !== null && o.accentColor !== '')
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'accentColor must look like #111111' }) accentColor?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() showLogo?: boolean;
  @ApiProperty({ required: false, enum: DOC_SIZES }) @IsOptional() @IsIn([...DOC_SIZES]) logoSize?: string;
  @ApiProperty({ required: false, enum: DOC_ALIGNS }) @IsOptional() @IsIn([...DOC_ALIGNS]) logoAlign?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() watermarkEnabled?: boolean;
  @ApiProperty({ required: false, enum: WATERMARK_TYPES }) @IsOptional() @IsIn([...WATERMARK_TYPES]) watermarkType?: string;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(40) watermarkText?: string | null;
  @ApiProperty({ required: false, enum: WATERMARK_POSITIONS }) @IsOptional() @IsIn([...WATERMARK_POSITIONS]) watermarkPosition?: string;
  @ApiProperty({ required: false, enum: WATERMARK_ANGLES }) @IsOptional() @IsIn([...WATERMARK_ANGLES]) watermarkAngle?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsInt() @Min(3) @Max(25) watermarkOpacity?: number;
  @ApiProperty({ required: false, enum: DOC_SIZES }) @IsOptional() @IsIn([...DOC_SIZES]) watermarkSize?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() slipShowPrices?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() slipShowSku?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() slipShowImages?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() slipShowNote?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() slipShowPayment?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() slipShowCheckbox?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(300) slipMessage?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(300) slipFooter?: string | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(30) invoiceTitle?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() invoiceShowSku?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() invoiceShowImages?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() invoiceShowTaxId?: boolean;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(600) invoiceTerms?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(300) invoiceFooter?: string | null;
}
