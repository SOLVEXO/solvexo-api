/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class StartConversationDto {
  @ApiProperty({ example: '665store001', description: 'Store to open a conversation with' })
  @IsString()
  @IsNotEmpty()
  storeId: string;
}
