import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsOptional,
  MaxLength,
  IsUrl,
  Matches,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiProperty({ required: false, example: 'Jami Raza' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiProperty({ required: false, example: 'jami@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: '+1234567890' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false, example: 'karachi, pakistan' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false, example: 'https://example.com/profile.jpg' })
  @IsOptional()
  @IsString()
  profileImage?: string;

  // Explicit buyer currency choice — once set, this is the source of truth
  // for checkout/display currency and wins over any location-based default
  // or guest cookie (see CheckoutService). Folded into the existing profile
  // endpoint rather than a dedicated route, matching this codebase's
  // existing API surface instead of adding a sibling endpoint for one field.
  // Shape-only check here (a real 3-letter code) — whether it's actually one
  // of the platform's real, dynamic ENABLED currencies is checked in
  // UsersService.updateProfile against the live Markets list, not a fixed
  // array (the old SUPPORTED_CURRENCIES 8-entry array this used to enforce
  // is retired — see checkout.service.ts's resolveCheckoutCurrency for why).
  @ApiProperty({ required: false, example: 'PKR', description: 'Real ISO-4217 3-letter code, validated against the platform\'s live enabled-currency list' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyPreference must be a 3-letter currency code' })
  currencyPreference?: string;
}
