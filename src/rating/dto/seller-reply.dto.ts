/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class SellerReplyDto {

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  text: string;

}
