import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, MinLength, IsNotEmpty } from 'class-validator';

export class RegisterDto {

    @IsString()
    @IsNotEmpty()
    name: string;

     @IsString()
    @IsNotEmpty()
    role: string;

  
    @IsEmail()
    @IsNotEmpty()
    email: string;


    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsString()
    address?: string;

   
    @IsString()
    @IsNotEmpty()
    password: string;


      @IsOptional()
    @IsString()
    profileImage?: string;

}