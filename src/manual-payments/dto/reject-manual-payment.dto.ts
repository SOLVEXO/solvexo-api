/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectManualPaymentDto {
  @ApiProperty({ example: 'Amount transferred does not match the order total' })
  @IsString() @IsNotEmpty()
  reason: string;
}
