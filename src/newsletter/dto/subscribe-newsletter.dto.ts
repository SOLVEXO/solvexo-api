import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class SubscribeNewsletterDto {
    @ApiProperty({ example: 'buyer@example.com' })
    @IsEmail()
    @IsNotEmpty({ message: 'Email is required' })
    email: string;
}
