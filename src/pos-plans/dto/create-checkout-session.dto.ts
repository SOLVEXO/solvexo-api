import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateCheckoutSessionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  planId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  successUrl: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  cancelUrl: string;
}
