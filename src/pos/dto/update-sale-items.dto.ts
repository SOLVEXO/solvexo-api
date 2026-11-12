/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SaleItemDto } from './create-sale.dto';

/** Same shape as a sale line (catalog item or G2.4 custom item); the server prices it. */
export class EditSaleItemDto extends SaleItemDto {}

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
