/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';
import { IsArray, IsInt, ValidateNested } from 'class-validator';
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

  @ApiProperty({ required: false, type: [Object], description: 'G4.6: the notes / coins counted into the float, [{ valueMinor, count }]. When sent, their total must equal openingCash.' })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => DenominationDto)
  denominations?: DenominationDto[];
}

export class DenominationDto {
  @ApiProperty({ example: 50000 }) @IsInt() @Min(1) valueMinor: number;
  @ApiProperty({ example: 3 }) @IsInt() @Min(0) count: number;
}
