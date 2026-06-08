import { ApiProperty } from '@nestjs/swagger';
import {
    IsString,
    IsNotEmpty,
    IsArray,
    IsNumber,
    Min,
    IsEnum,
    IsMongoId,
    ValidateNested,
    IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

// DTO for Order Item
export class CreateOrderItemDto {
    @ApiProperty({ example: '67a1b2c3d4e5f6g7h8i9j0k1' })
    @IsMongoId()
    @IsNotEmpty()
    product: string;

    @ApiProperty({ example: 'Samsung Galaxy S24' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ example: 2, minimum: 1 })
    @IsNumber()
    @Min(1)
    quantity: number;

    @ApiProperty({ example: 999.99 })
    @IsNumber()
    @Min(0)
    price: number;

    @ApiProperty({ required: false, example: 'https://example.com/image.jpg' })
    @IsOptional()
    @IsString()
    image?: string;
}

// DTO for Shipping Address
export class CreateShippingAddressDto {
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
}

// DTO for Creating Order
export class CreateOrderDto {
    @ApiProperty({ type: [CreateOrderItemDto] })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CreateOrderItemDto)
    orderItems: CreateOrderItemDto[];

    @ApiProperty({ type: CreateShippingAddressDto })
    @ValidateNested()
    @Type(() => CreateShippingAddressDto)
    shippingAddress: CreateShippingAddressDto;

    @ApiProperty({
        example: 'cash_on_delivery',
        enum: ['cash_on_delivery', 'credit_card', 'debit_card', 'paypal', 'stripe'],
    })
    @IsEnum(['cash_on_delivery', 'credit_card', 'debit_card', 'paypal', 'stripe'])
    @IsNotEmpty()
    paymentMethod: string;

    @ApiProperty({ example: 1999.98 })
    @IsNumber()
    @Min(0)
    itemsPrice: number;

    @ApiProperty({ example: 10.0, default: 0 })
    @IsNumber()
    @Min(0)
    shippingPrice: number;

    @ApiProperty({ example: 159.99, default: 0 })
    @IsNumber()
    @Min(0)
    taxPrice: number;

    @ApiProperty({ example: 2169.97 })
    @IsNumber()
    @Min(0)
    totalPrice: number;
}