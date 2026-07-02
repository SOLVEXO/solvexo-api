/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EditSaleItemDto {
  @ApiProperty({ example: '664variant1' })
  @IsString()
  variantId: string;

  @ApiProperty({ example: '664product1' })
  @IsString()
  productId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  qty: number;
}

export class UpdateSaleItemsDto {
  @ApiProperty({ type: [EditSaleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EditSaleItemDto)
  items: EditSaleItemDto[];

  @ApiProperty({ required: false, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @ApiProperty({ required: false, example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;
}
