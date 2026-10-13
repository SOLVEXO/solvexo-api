/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, IsIn, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

class CollectionRulesDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ required: false, enum: ['all', 'any'] })
  @IsOptional()
  @IsIn(['all', 'any'])
  matchType?: 'all' | 'any';

  @ApiProperty({ required: false, nullable: true, description: 'Only products whose title contains this text' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  titleContains?: string | null;
}

class CollectionSeoDto {
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(70) metaTitle?: string | null;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() @MaxLength(160) metaDescription?: string | null;
}

export const COLLECTION_SORTS = ['manual', 'newest', 'oldest', 'title_asc', 'title_desc', 'price_asc', 'price_desc', 'best_rated', 'best_selling'] as const;

export class UpdateCollectionDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  image?: string | null;

  @ApiProperty({ required: false, enum: ['manual', 'automatic'] })
  @IsOptional()
  @IsEnum(['manual', 'automatic'])
  type?: 'manual' | 'automatic';

  @ApiProperty({ required: false, type: CollectionRulesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionRulesDto)
  rules?: CollectionRulesDto;

  @ApiProperty({ required: false, enum: ['active', 'draft'] })
  @IsOptional()
  @IsIn(['active', 'draft'])
  status?: 'active' | 'draft';

  @ApiProperty({ required: false, description: 'Which of the store\'s own Collection alternate templates (collection-template module, resourceType: "collection") this collection renders through.' })
  @IsOptional()
  @IsString()
  templateKey?: string;

  @ApiProperty({ required: false, enum: COLLECTION_SORTS })
  @IsOptional()
  @IsIn(COLLECTION_SORTS)
  defaultSort?: (typeof COLLECTION_SORTS)[number];

  @ApiProperty({ required: false, type: CollectionSeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionSeoDto)
  seo?: CollectionSeoDto;
}
