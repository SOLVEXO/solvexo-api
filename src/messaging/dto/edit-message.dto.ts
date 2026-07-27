import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class EditMessageDto {
  @ApiProperty({ example: 'Updated message text' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  text: string;
}
