import { IsOptional, IsString, IsNumber } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  name: string;

  @IsOptional()
  parentId?: string;

  // Present → a store-owned category, created at the seller's own discretion
  // for that one store only. Omitted → the legacy global/admin taxonomy
  // (unchanged behavior). See CategoriesService.addCategory.
  @IsOptional()
  @IsString()
  storeId?: string;

  @IsString()
  @IsOptional()
  image?: string;

  @IsOptional()
  @IsOptional()
  description?: string;

  @IsOptional()
  sortOrder?: number;
}
