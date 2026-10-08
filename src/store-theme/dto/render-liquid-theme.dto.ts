import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class LiquidRenderCartItemDto {
  @IsString()
  @MaxLength(64)
  productId: string;

  @IsString()
  @MaxLength(64)
  productVariantId: string;

  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}

export class RenderLiquidThemeDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LiquidRenderCartItemDto)
  cartItems: LiquidRenderCartItemDto[];
}
