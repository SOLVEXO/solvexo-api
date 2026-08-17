/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CloseSessionDto {
  @ApiProperty({ example: '664session1' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;

  @ApiProperty({ example: 350, description: 'Physically counted cash at close' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  closingCash: number;
}
