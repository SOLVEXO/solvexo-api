import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, Min, IsIn, IsMongoId } from 'class-validator';
import { Type } from 'class-transformer';

export class ProductQueryDto {
    @ApiProperty({
        required: false,
        example: 'samsung galaxy',
        description: 'Search term (searches in name, description, brand)',
    })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiProperty({
        required: false,
        example: '67a1b2c3d4e5f6g7h8i9j0k1',
        description: 'Filter by category ID',
    })
    @IsOptional()
    @IsMongoId({ message: 'Invalid category ID' })
    category?: string;

    @ApiProperty({
        required: false,
        example: 100,
        description: 'Minimum price',
        minimum: 0,
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    minPrice?: number;

    @ApiProperty({
        required: false,
        example: 1000,
        description: 'Maximum price',
        minimum: 0,
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    maxPrice?: number;

    @ApiProperty({
        required: false,
        example: 'Samsung',
        description: 'Filter by brand',
    })
    @IsOptional()
    @IsString()
    brand?: string;

    @ApiProperty({
        required: false,
        example: 'price_asc',
        description: 'Sort order',
        enum: ['price_asc', 'price_desc', 'rating', 'newest', 'oldest'],
    })
    @IsOptional()
    @IsString()
    @IsIn(['price_asc', 'price_desc', 'rating', 'newest', 'oldest'])
    sort?: string;

    @ApiProperty({
        required: false,
        example: 1,
        description: 'Page number',
        minimum: 1,
        default: 1,
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(1)
    page?: number;

    @ApiProperty({
        required: false,
        example: 10,
        description: 'Items per page',
        minimum: 1,
        default: 10,
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(1)
    limit?: number;
}