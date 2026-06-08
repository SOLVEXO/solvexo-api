import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsNumber, IsNotEmpty, Min } from 'class-validator';

export class CreateFaqDto {
    @ApiProperty({
        example: 'How do I reset my password?',
        description: 'The FAQ question',
    })
    @IsString()
    @IsNotEmpty({ message: 'Question is required' })
    question: string;

    @ApiProperty({
        example: 'You can reset your password by clicking on "Forgot Password" on the login page.',
        description: 'The FAQ answer',
    })
    @IsString()
    @IsNotEmpty({ message: 'Answer is required' })
    answer: string;

    @ApiProperty({
        required: false,
        example: 'account',
        description: 'FAQ category (e.g., account, billing, general)',
        default: 'general',
    })
    @IsOptional()
    @IsString()
    category?: string;

    @ApiProperty({
        required: false,
        example: 1,
        description: 'Display order (lower numbers appear first)',
        default: 0,
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    order?: number;

    @ApiProperty({
        required: false,
        example: true,
        description: 'Whether the FAQ is active/visible',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    isActive?: boolean;
}

export class UpdateFaqDto extends PartialType(CreateFaqDto) { }