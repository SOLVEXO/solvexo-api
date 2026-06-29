/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray, Length } from 'class-validator';
import { EmployeeRole } from '../schemas/employee.schema';

export class UpdateEmployeeDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, description: '4-digit PIN' })
  @IsOptional()
  @IsString()
  @Length(4, 4, { message: 'PIN must be exactly 4 digits' })
  pin?: string;

  @ApiProperty({ enum: EmployeeRole, required: false })
  @IsOptional()
  @IsEnum(EmployeeRole)
  role?: EmployeeRole;

  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  shiftIds?: string[];

  @ApiProperty({ enum: ['active', 'inactive'], required: false })
  @IsOptional()
  @IsString()
  status?: string;
}
