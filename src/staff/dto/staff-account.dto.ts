import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateOwnStaffProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
}

export class ChangeOwnStaffPasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

export class StaffForgotPasswordDto {
  @IsEmail()
  email: string;
}

export class StaffResetPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
