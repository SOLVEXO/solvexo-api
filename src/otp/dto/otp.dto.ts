import { ApiProperty } from '@nestjs/swagger';
import {
    IsEmail,
    IsString,
    IsNotEmpty,
    Length,
    IsEnum,
    IsOptional,
} from 'class-validator';

export class SendOtpDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({
        example: 'email_verification',
        enum: ['email_verification', 'password_reset', 'login'],
        required: false
    })
    @IsOptional()
    @IsEnum(['email_verification', 'password_reset', 'login'])
    type?: string;
}

export class VerifyOtpDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({ example: '123456' })
    @IsString()
    @IsNotEmpty()
    @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
    otp: string;

    @ApiProperty({
        example: 'email_verification',
        enum: ['email_verification', 'password_reset', 'login'],
        required: false
    })
    @IsOptional()
    @IsEnum(['email_verification', 'password_reset', 'login'])
    type?: string;
}

export class ResendOtpDto {
    @ApiProperty({ example: 'user@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({
        example: 'email_verification',
        enum: ['email_verification', 'password_reset', 'login'],
        required: false
    })
    @IsOptional()
    @IsEnum(['email_verification', 'password_reset', 'login'])
    type?: string;
}