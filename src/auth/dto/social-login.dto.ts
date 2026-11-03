import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  IsEnum,
  IsIn,
} from 'class-validator';

export class SocialLoginDto {
  @ApiProperty({
    example: 'google',
    enum: ['google', 'facebook', 'apple'],
    description: 'Social auth provider',
  })
  @IsEnum(['google', 'facebook', 'apple'])
  @IsNotEmpty()
  authProvider: string;

  @ApiProperty({
    example: 'social-provider-id-12345',
    description: 'Unique ID from social provider',
  })
  @IsString()
  @IsNotEmpty()
  socialId: string;

  // Legacy field name — kept for backward compatibility with any caller
  // still sending `userName`. The frontend actually sends `name` (below).
  @ApiProperty({ required: false, example: 'John Doe' })
  @IsOptional()
  @IsString()
  userName?: string;

  @ApiProperty({ required: false, example: 'John Doe' })
  @IsOptional()
  @IsString()
  name?: string;

  // Optional: Sign in with Apple may not share an email after the first sign-in. When the provider token carries a
  // verified email that is used; otherwise login falls back to the verified provider id.
  @ApiProperty({ example: 'john@example.com', required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  // Which account this social login should resolve against — 'user' (buyer,
  // default) or 'seller'. Buyer and seller are separate collections, so this
  // has to be explicit the same way LoginDto/RegisterDto already are.
  @ApiProperty({ required: false, enum: ['user', 'seller'], example: 'seller' })
  @IsOptional()
  @IsIn(['user', 'seller'])
  role?: 'user' | 'seller';

  @ApiProperty({
    required: false,
    example: 'https://example.com/avatar.jpg',
    description: 'Profile image URL from provider',
  })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiProperty({
    required: false,
    example: 'fcm-token-12345',
    description: 'Firebase Cloud Messaging token for push notifications',
  })
  @IsOptional()
  @IsString()
  fcmToken?: string;

  @ApiProperty({
    required: false,
    example: 'id-token-from-provider',
    description: 'OAuth token from provider (for additional verification)',
  })
  @IsOptional()
  @IsString()
  token?: string;

  // Sign in with Apple: the one-time authorization code from the same sign-in. The backend exchanges it for Apple's refresh
  // token (stored encrypted) so deleting the account can revoke it. Optional: login never depends on it.
  @ApiProperty({ required: false, description: 'Apple authorizationCode (apple only)' })
  @IsOptional()
  @IsString()
  authorizationCode?: string;

  // Same store-scoping as RegisterDto/LoginDto.storeId — see User.storeId.
  // Backend-contract-complete; no storefront social-login UI sends this yet.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  storeId?: string;
}
