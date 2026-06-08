import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, MaxLength, IsUrl } from 'class-validator';

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
}