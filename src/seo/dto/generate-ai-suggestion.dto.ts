/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsNotEmpty, IsArray, ArrayMinSize } from 'class-validator';

export const AI_SEO_ENTITY_TYPES = ['product', 'category', 'store'] as const;

export class GenerateAiSuggestionDto {
  @ApiProperty({ enum: AI_SEO_ENTITY_TYPES })
  @IsIn(AI_SEO_ENTITY_TYPES)
  entityType: 'product' | 'category' | 'store';

  @ApiProperty()
  @IsString() @IsNotEmpty()
  entityId: string;
}

export class GenerateAiSuggestionBulkDto {
  @ApiProperty({ enum: AI_SEO_ENTITY_TYPES })
  @IsIn(AI_SEO_ENTITY_TYPES)
  entityType: 'product' | 'category' | 'store';

  @ApiProperty({ type: [String] })
  @IsArray() @ArrayMinSize(1)
  entityIds: string[];
}
