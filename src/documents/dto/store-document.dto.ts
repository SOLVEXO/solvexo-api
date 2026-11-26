import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { STORE_DOCUMENT_CATEGORIES, StoreDocumentCategory } from '../schemas/store-document.schema';

/** The file is uploaded first (`POST :storeId/upload`); the body then points at it. */
export class CreateDocumentFileDto {
  @IsString()
  @Length(1, 120)
  title: string;

  @IsOptional()
  @IsIn(STORE_DOCUMENT_CATEGORIES as unknown as string[])
  category: StoreDocumentCategory;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Must live under `documents/<storeId>/` — checked in the service. */
  @IsString()
  @Length(1, 400)
  publicId: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  fileUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  coverPublicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  coverUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  pages?: number;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  language?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateDocumentFileDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  title?: string;

  @IsOptional()
  @IsIn(STORE_DOCUMENT_CATEGORIES as unknown as string[])
  category?: StoreDocumentCategory;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  language?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Set by `replace-file`: the new file already uploaded under the same folder. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  publicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  fileUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  pages?: number;
}

export class ListDocumentFilesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(STORE_DOCUMENT_CATEGORIES as unknown as string[])
  category?: StoreDocumentCategory;

  @IsOptional()
  @IsIn(['active', 'hidden'])
  status?: string;
}

/** Public list of a store's documents — what the storefront grid renders. */
export class PublicDocumentFilesQueryDto {
  @IsOptional()
  @IsIn(STORE_DOCUMENT_CATEGORIES as unknown as string[])
  category?: StoreDocumentCategory;

  @IsArray()
  @IsOptional()
  ids?: string[];
}