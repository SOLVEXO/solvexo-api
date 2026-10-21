/* eslint-disable prettier/prettier */
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength, ValidateNested } from 'class-validator';

export class TextTranslationEntryDto {
  @IsString() @MaxLength(200) key: string;
  /** Empty text removes the translation (the storefront shows the original again). */
  @IsString() @MaxLength(5000) value: string;
}

export class SaveTextTranslationsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => TextTranslationEntryDto)
  entries: TextTranslationEntryDto[];
}

export class AutoTranslateTextDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(200, { each: true })
  keys: string[];
}
