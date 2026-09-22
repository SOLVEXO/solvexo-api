/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class ToggleReactionDto {
  @ApiProperty({ example: '❤️' })
  @IsString()
  @IsNotEmpty()
  emoji: string;
}
