/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateRegisterDto {
  @ApiProperty({ required: false, example: 'Register 2' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, example: 150 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  defaultFloatCash?: number;

  @ApiProperty({ required: false, enum: ['active', 'inactive'] })
  @IsOptional()
  @IsEnum(['active', 'inactive'])
  status?: string;

  @ApiProperty({ required: false, description: 'StoreLocation _id, or null to unassign' })
  @IsOptional()
  @IsString()
  locationId?: string | null;
}
