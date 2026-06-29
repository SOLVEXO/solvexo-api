/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEmail, IsOptional, IsEnum, IsArray, Length } from 'class-validator';
import { EmployeeRole } from '../schemas/employee.schema';

export class CreateEmployeeDto {
  @ApiProperty({ example: '664abc123' })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'john@store.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '1234', description: '4-digit PIN' })
  @IsString()
  @Length(4, 4, { message: 'PIN must be exactly 4 digits' })
  pin: string;

  @ApiProperty({ enum: EmployeeRole, default: EmployeeRole.CASHIER, required: false })
  @IsOptional()
  @IsEnum(EmployeeRole)
  role?: EmployeeRole;

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  shiftIds?: string[];
}
