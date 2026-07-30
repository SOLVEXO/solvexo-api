/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SubmitManualPaymentDto {
  @ApiProperty({ example: '665checkout001' })
  @IsString() @IsNotEmpty()
  checkoutId: string;

  @ApiProperty({ required: false, example: 'TXN123456789', description: 'Bank/wallet transaction reference, if the buyer has one' })
  @IsOptional() @IsString()
  transactionReference?: string;

  @ApiProperty({ required: false, example: 'Ali Raza', description: 'Name the transfer was sent from, if different from the buyer\'s account name' })
  @IsOptional() @IsString()
  senderName?: string;
}
