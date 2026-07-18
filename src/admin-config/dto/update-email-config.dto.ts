/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

export class UpdateEmailConfigDto {
  @ApiProperty({ required: false, example: 'Solvexo' })
  @IsOptional()
  @IsString()
  fromName?: string;

  @ApiProperty({ required: false, example: 'noreply@solvexo.com' })
  @IsOptional()
  @IsEmail()
  fromEmail?: string;

  @ApiProperty({ required: false, example: 'support@solvexo.com' })
  @IsOptional()
  @IsEmail()
  replyToEmail?: string;

  @ApiProperty({ required: false, example: 'SendGrid' })
  @IsOptional()
  @IsString()
  provider?: string;
}
