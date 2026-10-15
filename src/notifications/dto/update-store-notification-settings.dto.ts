/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsObject, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class UpdateStoreNotificationSettingsDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  senderName?: string | null;

  /** '' or null clears it (falls back to the store's contact email). */
  @ApiProperty({ required: false, nullable: true })
  @ValidateIf((o) => o.replyToEmail !== undefined && o.replyToEmail !== null && o.replyToEmail !== '')
  @IsEmail()
  @MaxLength(200)
  replyToEmail?: string | null;

  /** '#rrggbb', or ''/null to go back to the default colour. */
  @ApiProperty({ required: false, nullable: true })
  @ValidateIf((o) => o.accentColor !== undefined && o.accentColor !== null && o.accentColor !== '')
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'accentColor must look like #d97757' })
  accentColor?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  footerText?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  showLogo?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEmail({}, { each: true })
  staffOrderEmails?: string[];

  /** { [event]: { enabled?, subject?, body?, reset? } } — each key/value is validated in the service against the catalog. */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  events?: Record<string, { enabled?: boolean; subject?: string | null; body?: string | null; reset?: boolean }>;

  /** { [event]: { [locale]: { subject?, body?, reset? } } } — the seller's own text per language (validated in the service). */
  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  eventTranslations?: Record<string, Record<string, { subject?: string | null; body?: string | null; reset?: boolean }>>;
}

export class PreviewCustomerEmailDto {
  @ApiProperty()
  @IsString()
  event: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string | null;

  /** Language to render the sample in ('ur', ...). Default English. */
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string | null;
}
