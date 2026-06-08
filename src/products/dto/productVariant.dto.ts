import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';

export class CreateProductVariantDto {

  @IsString()
  productId: string;

  @IsString()
  sku: string;

  @IsOptional()
  @IsString()
  size?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsNumber()
  price: number;

  @IsOptional()
  @IsNumber()
  stock?: number;

  @IsOptional()
  @IsArray()
  images?: string[];
}