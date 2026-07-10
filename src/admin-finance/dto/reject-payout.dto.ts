/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectPayoutDto {
  @ApiProperty({ example: 'Bank details could not be verified' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
