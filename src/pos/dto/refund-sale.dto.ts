/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray, IsNumber, IsOptional, IsString, MaxLength, Min, ValidateNested,
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

  @ApiProperty({ required: false, description: 'Why the refund is being made (optional; recorded on the refund record)' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @ApiProperty({ required: false, description: 'G2.4 reason code (picker): wrong_item, damaged_or_defective, customer_changed_mind, price_error, duplicate_charge, other' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reasonCode?: string;
}
