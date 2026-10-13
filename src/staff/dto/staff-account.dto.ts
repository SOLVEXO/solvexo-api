import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateOwnStaffProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  /** Digits, spaces and + ( ) - only; empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  @Matches(/^[0-9+()\-\s]*$/, { message: 'Phone can only contain digits, spaces and + ( ) -' })
  phone?: string;

  /** An https image URL (from the upload endpoint); empty string removes the photo. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(https:\/\/\S+)?$/, { message: 'Profile photo must be an https image URL' })
  profileImage?: string;
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
