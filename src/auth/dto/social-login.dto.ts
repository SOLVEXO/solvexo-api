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

  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

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
}
