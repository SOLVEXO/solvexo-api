import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsNotEmpty } from 'class-validator';

export class LoginDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;


    @IsString()
    @IsNotEmpty()
    password: string;

     @IsString()
    @IsNotEmpty()
    role: string;
}