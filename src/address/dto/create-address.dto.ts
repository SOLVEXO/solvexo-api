import { ApiProperty } from '@nestjs/swagger';
import {
    IsString,
    IsNotEmpty,
    IsBoolean,
    IsEnum,
    IsOptional,
    MaxLength,
    MinLength,
} from 'class-validator';

export class CreateAddressDto {
    @ApiProperty({ example: 'John Doe' })
    @IsString()
    @IsNotEmpty()
    fullName: string;

    @ApiProperty({ example: '+1234567890' })
    @IsString()
    @IsNotEmpty()
    phone: string;

    @ApiProperty({ example: '123 Main Street' })
    @IsString()
    @IsNotEmpty()
    addressLine1: string;

    @ApiProperty({ required: false, example: 'Apt 4B' })
    @IsOptional()
    @IsString()
    addressLine2?: string;

    @ApiProperty({ example: 'New York' })
    @IsString()
    @IsNotEmpty()
    city: string;

    @ApiProperty({ example: 'NY' })
    @IsString()
    @IsNotEmpty()
    state: string;

    @ApiProperty({ example: '10001' })
    @IsString()
    @IsNotEmpty()
    zipCode: string;

    @ApiProperty({ example: 'United States' })
    @IsString()
    @IsNotEmpty()
    country: string;

    @ApiProperty({ required: false, default: false })
    @IsOptional()
    @IsBoolean()
    isDefault?: boolean;

    @ApiProperty({
        required: false,
        enum: ['home', 'work', 'other'],
        default: 'home'
    })
    @IsOptional()
    @IsEnum(['home', 'work', 'other'])
    type?: string;

    @ApiProperty({ required: false, example: "Mom's House" })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    label?: string;
}

export class UpdateAddressDto {
    @ApiProperty({ required: false, example: 'John Doe' })
    @IsOptional()
    @IsString()
    fullName?: string;

    @ApiProperty({ required: false, example: '+1234567890' })
    @IsOptional()
    @IsString()
    phone?: string;

    @ApiProperty({ required: false, example: '123 Main Street' })
    @IsOptional()
    @IsString()
    addressLine1?: string;

    @ApiProperty({ required: false, example: 'Apt 4B' })
    @IsOptional()
    @IsString()
    addressLine2?: string;

    @ApiProperty({ required: false, example: 'New York' })
    @IsOptional()
    @IsString()
    city?: string;

    @ApiProperty({ required: false, example: 'NY' })
    @IsOptional()
    @IsString()
    state?: string;

    @ApiProperty({ required: false, example: '10001' })
    @IsOptional()
    @IsString()
    zipCode?: string;

    @ApiProperty({ required: false, example: 'United States' })
    @IsOptional()
    @IsString()
    country?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsBoolean()
    isDefault?: boolean;

    @ApiProperty({
        required: false,
        enum: ['home', 'work', 'other']
    })
    @IsOptional()
    @IsEnum(['home', 'work', 'other'])
    type?: string;

    @ApiProperty({ required: false })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    label?: string;
}