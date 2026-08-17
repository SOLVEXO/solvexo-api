import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUrl, IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOnboardingSlideDto {
  @ApiProperty({ example: 'Shop from anywhere' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ required: false, example: 'Browse thousands of products from local sellers' })
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiProperty({
    required: false,
    example: 'https://res.cloudinary.com/demo/image/upload/slide.jpg',
    description: 'Direct image URL — use this OR upload a file via /upload',
  })
  @IsOptional()
  @IsUrl({}, { message: 'imageUrl must be a valid URL' })
  imageUrl?: string;

  @ApiProperty({ required: false, example: 0, description: 'Display order (0 = first)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  order?: number;
}
