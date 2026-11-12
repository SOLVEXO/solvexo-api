/* eslint-disable prettier/prettier */
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class UpdateFbrSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['sandbox', 'production']) mode?: 'sandbox' | 'production';
  @IsOptional() @IsString() @MaxLength(60) province?: string;
  @IsOptional() @IsString() @MaxLength(120) legalName?: string;
  @IsOptional() @IsString() @Matches(/^SN\d{3}$/, { message: 'Scenario must look like SN002' }) scenarioId?: string;
  @IsOptional() @IsString() @MaxLength(12) @Matches(/^(\d{4}\.\d{4}|\d{8})?$/, { message: 'HS code must look like 0101.2100' }) hsCode?: string;
  @IsOptional() @IsString() @MaxLength(80) uom?: string;
  @IsOptional() @IsString() @MaxLength(80) saleType?: string;
}

/** Settles an invoice whose outcome is unknown (after the person checked the FBR portal). Allowed once per record. */
export class ResolveFbrInvoiceDto {
  @IsIn(['filed', 'resend']) action: 'filed' | 'resend';
  /** Required for 'filed': the number exactly as the FBR portal shows it (7-digit NTN or 13-digit CNIC + DI + 13 digits). */
  @ValidateIf((o: ResolveFbrInvoiceDto) => o.action === 'filed')
  @IsString() @Matches(/^(\d{7}|\d{13})DI\d{13}$/, { message: 'Enter the FBR invoice number exactly as the FBR portal shows it' }) fbrInvoiceNumber?: string;
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/, { message: 'Date must look like 2026-11-11 or 2026-11-11 10:05:00' }) fbrDated?: string;
}

export class SetFbrTokenDto {
  @IsIn(['sandbox', 'production']) mode: 'sandbox' | 'production';
  @IsString() @MinLength(20) @MaxLength(4000) token: string;
}
