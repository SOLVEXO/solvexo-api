/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEmail, Length } from 'class-validator';

export class PinLoginDto {
  @ApiProperty({ example: '664abc123' })
  @IsString()
  @IsNotEmpty()
  storeId: string;

  @ApiProperty({ example: 'john@store.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '1234' })
  @IsString()
  @Length(4, 4, { message: 'PIN must be exactly 4 digits' })
  pin: string;
}
