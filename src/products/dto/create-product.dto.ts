import { IsOptional, IsString, IsNumber, IsArray } from 'class-validator';

export class CreateProductDto {

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsString()
  categoryId: string;


}