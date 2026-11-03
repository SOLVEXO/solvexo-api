import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

export class CreatePosPlanDto {
  @ApiProperty({ example: '3 Month Plan' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 49 })
  @IsNumber()
  @IsPositive()
  price: number;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({ example: 90 })
  @IsInt()
  @Min(1)
  durationInDays: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, nullable: true, description: 'Max registers while this plan is active (null = unlimited)' })
  @IsOptional() @IsInt() @Min(1)
  maxRegisters?: number | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsInt() @Min(1)
  maxEmployees?: number | null;

  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsInt() @Min(1)
  maxLocations?: number | null;
}
