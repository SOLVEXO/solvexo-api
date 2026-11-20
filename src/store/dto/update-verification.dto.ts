/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { BUSINESS_TYPES, ID_DOCUMENT_TYPES, VERIFICATION_DOCUMENT_TYPES } from '../schemas/store.schema';
import type { BusinessType, VerificationDocumentType } from '../schemas/store.schema';
import { KYC_DOCUMENT_RESOURCE_TYPES } from '../../upload/upload-file-validation';

// Input limits for the seller business-verification form. Identity fields are only ever stored, never rendered
// as HTML, but an unbounded string would still bloat the store document, so every field has a ceiling.
// The service re-checks the rules that depend on the country (CNIC / NTN formats) and on the store (document owner).

export const VERIFICATION_LIMITS = {
  legalBusinessName: 150,
  registrationNumber: 40,
  taxId: 50,
  businessAddress: 300,
  idNumber: 50,
  strn: 30,
  contactName: 100,
  contactDesignation: 100,
  contactEmail: 254,
  contactPhone: 30,
  directorName: 100,
  directorId: 50,
  fileName: 200,
  publicId: 300,
  maxDocuments: 12,
} as const;

export class AuthorizedContactDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.contactName)
  name?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.contactDesignation)
  designation?: string;

  // An empty string is allowed: a draft can be saved before the email is typed.
  @ApiProperty({ required: false })
  @ValidateIf((o) => o.email !== undefined && o.email !== null && o.email !== '')
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(VERIFICATION_LIMITS.contactEmail)
  email?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.contactPhone)
  phone?: string;
}

export class DirectorDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.directorName)
  name?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.directorId)
  idNumber?: string;
}

export class VerificationDocumentInputDto {
  @ApiProperty({ enum: VERIFICATION_DOCUMENT_TYPES }) @IsIn([...VERIFICATION_DOCUMENT_TYPES])
  type: VerificationDocumentType;

  @ApiProperty() @IsString() @MaxLength(VERIFICATION_LIMITS.publicId)
  publicId: string;

  @ApiProperty({ required: false, enum: KYC_DOCUMENT_RESOURCE_TYPES }) @IsOptional() @IsIn([...KYC_DOCUMENT_RESOURCE_TYPES])
  resourceType?: string;

  @ApiProperty() @IsString() @MaxLength(VERIFICATION_LIMITS.fileName)
  fileName: string;
}

export class UpdateVerificationDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(10)
  country?: string;

  @ApiProperty({ required: false, enum: BUSINESS_TYPES }) @IsOptional() @IsIn([...BUSINESS_TYPES])
  businessType?: BusinessType;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.legalBusinessName)
  legalBusinessName?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.registrationNumber)
  registrationNumber?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.taxId)
  taxId?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.businessAddress)
  businessAddress?: string;

  @ApiProperty({ required: false, enum: ID_DOCUMENT_TYPES }) @IsOptional() @IsIn([...ID_DOCUMENT_TYPES])
  idDocumentType?: string;

  @ApiProperty({ required: false, type: AuthorizedContactDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => AuthorizedContactDto)
  authorizedContact?: AuthorizedContactDto;

  @ApiProperty({ required: false, type: DirectorDto, description: 'Company / partnership: the director or partner behind the business' })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => DirectorDto)
  director?: DirectorDto;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.idNumber)
  cnicNumber?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.strn)
  strn?: string | null;

  // The questionnaire is validated answer by answer in StoreService.parseBusinessProfile.
  @ApiProperty({ required: false }) @IsOptional() @IsObject()
  businessProfile?: Record<string, unknown>;

  @ApiProperty({ required: false, type: [VerificationDocumentInputDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(VERIFICATION_LIMITS.maxDocuments) @ValidateNested({ each: true }) @Type(() => VerificationDocumentInputDto)
  documents?: VerificationDocumentInputDto[];
}

/** POST :storeId/verification/submit — the seller's declaration. Must be exactly `true`. */
export class SubmitVerificationDto {
  @ApiProperty({ description: 'The seller ticked the declaration' }) @IsBoolean()
  declarationAccepted: boolean;
}

/** POST :storeId/verification/documents — attach a file that was just uploaded privately. */
export class AttachVerificationDocumentDto {
  @ApiProperty({ enum: VERIFICATION_DOCUMENT_TYPES }) @IsIn([...VERIFICATION_DOCUMENT_TYPES])
  type: VerificationDocumentType;

  @ApiProperty() @IsString() @MaxLength(VERIFICATION_LIMITS.publicId)
  publicId: string;

  @ApiProperty({ enum: KYC_DOCUMENT_RESOURCE_TYPES }) @IsIn([...KYC_DOCUMENT_RESOURCE_TYPES])
  resourceType: string;

  @ApiProperty() @IsString() @MaxLength(VERIFICATION_LIMITS.fileName)
  fileName: string;
}

/** POST :storeId/verification/change — a VERIFIED seller asks to change details / files. Only what changed needs to be sent. */
export class RequestVerificationChangeDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.legalBusinessName)
  legalBusinessName?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.registrationNumber)
  registrationNumber?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.taxId)
  taxId?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.strn)
  strn?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.idNumber)
  cnicNumber?: string | null;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(VERIFICATION_LIMITS.businessAddress)
  businessAddress?: string | null;

  @ApiProperty({ required: false, type: AuthorizedContactDto })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => AuthorizedContactDto)
  authorizedContact?: AuthorizedContactDto;

  @ApiProperty({ required: false, type: DirectorDto, description: 'Company / partnership: the director or partner behind the business' })
  @IsOptional() @IsObject() @ValidateNested() @Type(() => DirectorDto)
  director?: DirectorDto;

  @ApiProperty({ required: false, type: [VerificationDocumentInputDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(VERIFICATION_LIMITS.maxDocuments) @ValidateNested({ each: true }) @Type(() => VerificationDocumentInputDto)
  documents?: VerificationDocumentInputDto[];

  @ApiProperty({ required: false, description: 'Why the details changed (shown to the reviewer)' }) @IsOptional() @IsString() @MaxLength(500)
  note?: string | null;

  @ApiProperty({ description: 'The seller ticked the declaration' }) @IsBoolean()
  declarationAccepted: boolean;
}
