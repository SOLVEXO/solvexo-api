/* eslint-disable prettier/prettier */
import { IsString, IsOptional, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateProfileDto {

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  profileImage?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  fcmToken?: string;

  // This is the DTO actually wired to PATCH /api/auth/edit-profile — the
  // route the frontend calls for profile updates (see
  // AuthController.editProfile) — NOT UsersController's separate
  // PUT /api/users/profile, which exists but isn't the one the app uses.
  // Shape-only check here (a real 3-letter code) — whether it's actually
  // one of the platform's real, dynamic ENABLED currencies is checked in
  // AuthService.editProfile against the live Markets list, not a fixed
  // array (the old SUPPORTED_CURRENCIES 8-entry array this used to enforce
  // is retired — see checkout.service.ts's resolveCheckoutCurrency for why).
  @ApiProperty({ required: false, example: 'PKR', description: 'Real ISO-4217 3-letter code, validated against the platform\'s live enabled-currency list' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyPreference must be a 3-letter currency code' })
  currencyPreference?: string;

}
