import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsOptional,
  MinLength,
  IsNotEmpty,
  IsIn,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  // Public registration can only ever create a buyer or seller account —
  // 'admin' is deliberately not an allowed value here. Admin accounts are
  // created only via the JwtAuthGuard+Roles('admin')-protected
  // POST /api/auth/admin/create-admin endpoint (see AuthController).
  @IsString()
  @IsNotEmpty()
  @IsIn(['user', 'seller'])
  role: 'user' | 'seller';

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsOptional()
  @IsString()
  profileImage?: string;
}
