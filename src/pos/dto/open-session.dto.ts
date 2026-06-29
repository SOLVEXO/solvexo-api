/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class OpenSessionDto {
  @ApiProperty({ example: '664abc123' })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({ example: '664abc456', description: 'Register _id from store.registers' })
  @IsString()
  @IsNotEmpty()
  registerId: string;

  @ApiProperty({ example: '664abc789', description: 'Employee _id opening the session' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ required: false, example: '664shift1', description: 'Shift _id from store.shifts' })
  @IsOptional()
  @IsString()
  shiftId?: string;

  @ApiProperty({ example: 100, description: 'Opening float cash amount' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  openingCash: number;
}
