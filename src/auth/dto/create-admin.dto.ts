import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

// Only reachable via POST /api/auth/admin/create-admin, which is guarded by
// JwtAuthGuard + Roles('admin') — this DTO has no `role` field at all
// because the caller can never choose it; the service always creates an
// 'admin' document. This is the "minimal protected admin-only creation
// endpoint" that public registration no longer provides for admin accounts.
export class CreateAdminDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;
}
