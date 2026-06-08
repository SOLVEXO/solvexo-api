import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class UpdateOrderToPaidDto {
    @ApiProperty({ example: 'pay_123456789' })
    @IsString()
    id: string;

    @ApiProperty({ example: 'completed' })
    @IsString()
    status: string;

    @ApiProperty({ example: '2026-02-09T10:30:00Z' })
    @IsString()
    update_time: string;

    @ApiProperty({ required: false, example: 'customer@example.com' })
    @IsOptional()
    @IsString()
    email_address?: string;
}