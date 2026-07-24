import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min } from 'class-validator';

// Documents the shape of `digital.preview` accepted inside the
// add-digital-product / edit-product request bodies (both untyped `any` in
// this codebase's existing convention — see products.controller.ts). Bounds
// validation of `sourceFileIndex` happens inline in
// ProductsService.prepareDigitalPreview.
export class DigitalPreviewDto {
  @ApiProperty({ required: false, example: true, description: 'Enable a watermarked/trimmed preview for this product' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({ required: false, example: 0, description: 'Index into digital.files to derive the preview from', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sourceFileIndex?: number;
}
