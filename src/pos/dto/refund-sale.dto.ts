/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RefundItemDto {
  @ApiProperty({ example: '664saleitem1', description: 'The _id of the SaleItem subdocument' })
  @IsString()
  saleItemId: string;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  qty: number;
}

export class RefundSaleDto {
  @ApiProperty({ type: [RefundItemDto], required: false, description: 'Omit for full refund' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RefundItemDto)
  items?: RefundItemDto[];

  @ApiProperty({ required: false, example: '664employee1', description: 'Acting employee — must be manager role' })
  @IsOptional()
  @IsString()
  actingEmployeeId?: string;
}
