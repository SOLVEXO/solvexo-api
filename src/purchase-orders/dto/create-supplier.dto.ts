/* eslint-disable prettier/prettier */
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateSupplierDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsOptional() @IsString()
  email?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString() @MaxLength(120)
  contactName?: string;

  @IsOptional() @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @IsString() @MaxLength(80)
  country?: string;

  @IsOptional() @IsInt() @Min(0) @Max(365)
  leadTimeDays?: number;

  @IsOptional() @IsString() @MaxLength(60)
  paymentTerms?: string;
}
