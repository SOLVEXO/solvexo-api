/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsArray, ValidateNested,
  IsNumber, IsOptional, IsEnum, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SaleItemDto {
  @ApiProperty({ example: '664product1' })
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty({ example: '664variant1' })
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  qty: number;
}

export class CreateSaleDto {
  @ApiProperty({ example: '664abc123' })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({ example: '664session1' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @ApiProperty({ example: '664register1' })
  @IsString()
  @IsNotEmpty()
  registerId: string;

  @ApiProperty({ example: '664employee1' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiProperty({ example: 0, required: false, description: 'Flat discount amount' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discount?: number;

  @ApiProperty({ example: 0, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  tax?: number;

  @ApiProperty({ enum: ['cash', 'card', 'other'], default: 'cash' })
  @IsEnum(['cash', 'card', 'other'])
  paymentMethod: string;

  @ApiProperty({ required: false, example: '664user1' })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiProperty({ required: false, example: 'Sarah M.' })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiProperty({ required: false, example: 'Customer requested gift wrap' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ enum: ['completed', 'held'], default: 'completed', required: false })
  @IsOptional()
  @IsEnum(['completed', 'held'])
  status?: 'completed' | 'held';

  @ApiProperty({ required: false, example: 'idem_abc123', description: 'Client-generated key — prevents duplicate sales on retry' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
