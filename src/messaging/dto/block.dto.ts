/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEnum, IsOptional } from 'class-validator';

export class BlockDto {
  @ApiProperty({ example: '665user001' })
  @IsString()
  @IsNotEmpty()
  targetId: string;

  @ApiProperty({ enum: ['user', 'seller'] })
  @IsEnum(['user', 'seller'])
  targetRole: string;

  @ApiProperty({ required: false, example: 'Spam messages' })
  @IsOptional()
  @IsString()
  reason?: string;
}
