/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, IsOptional, IsEmail, Min } from 'class-validator';

export class IssueManualGiftCardDto {
  @ApiProperty({ example: 25 })
  @IsNumber()
  @Min(1)
  value: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  recipientEmail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  recipientName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  message?: string;
}
