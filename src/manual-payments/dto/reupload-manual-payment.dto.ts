/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ReuploadManualPaymentDto {
  @ApiProperty({ required: false, example: 'TXN123456789' })
  @IsOptional() @IsString()
  transactionReference?: string;

  @ApiProperty({ required: false, example: 'Ali Raza' })
  @IsOptional() @IsString()
  senderName?: string;
}
