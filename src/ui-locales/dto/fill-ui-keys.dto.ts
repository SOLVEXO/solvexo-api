/* eslint-disable prettier/prettier */
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';

export class FillUiKeysDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(200, { each: true })
  keys: string[];
}
