/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, ArrayMaxSize } from 'class-validator';

// Whole-array rewrite, same convention as Store.pinnedProductIds — order in
// the array IS display order.
export class UpdateCollectionProductsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  productIds: string[];
}
