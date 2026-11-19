/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, MaxLength } from 'class-validator';

export class SendAbandonedCartTestDto {
  @ApiProperty({ required: false, description: "Where to send the test. Defaults to the store's contact email." })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
