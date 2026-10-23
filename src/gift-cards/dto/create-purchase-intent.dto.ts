/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsEmail, IsISO8601, Min } from 'class-validator';

export class CreatePurchaseIntentDto {
  @ApiProperty({ example: 50 })
  @IsNumber()
  @Min(1)
  amount: number;

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

  /** A gift only: the day (YYYY-MM-DD) the code should be emailed to the recipient. Empty = send right after payment. */
  @ApiProperty({ required: false, example: '2026-12-25' })
  @IsOptional()
  @IsISO8601({ strict: true })
  sendOn?: string;
}
