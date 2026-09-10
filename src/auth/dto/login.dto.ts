import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  // Same store-scoping as RegisterDto.storeId — must match the storeId the
  // account was actually registered under, or the lookup won't find it.
  @IsOptional()
  @IsString()
  storeId?: string;
}
