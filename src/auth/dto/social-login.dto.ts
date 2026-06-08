import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEmail, IsOptional, IsEnum } from 'class-validator';

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

    @ApiProperty({ example: 'John Doe' })
    @IsString()
    @IsNotEmpty()
    userName: string;

    @ApiProperty({ example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

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