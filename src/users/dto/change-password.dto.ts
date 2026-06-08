import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, IsNotEmpty } from 'class-validator';

export class ChangePasswordDto {
    @ApiProperty({ example: 'OldPassword123!' })
    @IsString()
    @IsNotEmpty()
    currentPassword: string;

    @ApiProperty({ example: 'NewPassword123!', minLength: 6 })
    @IsString()
    @MinLength(6, { message: 'New password must be at least 6 characters long' })
    @IsNotEmpty()
    newPassword: string;
}