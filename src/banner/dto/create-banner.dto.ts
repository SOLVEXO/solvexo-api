import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUrl, IsString } from 'class-validator';

export class CreateBannerDto {
    @ApiProperty({
        required: false,
        example: 'https://example.com/banner.jpg',
        description: 'Direct image URL (use this OR upload a file)',
    })
    @IsOptional()
    @IsUrl({}, { message: 'imageUrl must be a valid URL' })
    imageUrl?: string;
}