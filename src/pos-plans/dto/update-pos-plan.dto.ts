import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

export class UpdatePosPlanDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  currency?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  durationInDays?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  // No DELETE endpoint — retire a plan via isActive: false instead (see
  // PosPlan schema doc comment for why hard-delete is avoided).
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, nullable: true, description: 'Max registers while this plan is active (null = unlimited)' })
  @IsOptional() @IsInt() @Min(1)
  maxRegisters?: number | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsInt() @Min(1)
  maxEmployees?: number | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsInt() @Min(1)
  maxLocations?: number | null;
}
