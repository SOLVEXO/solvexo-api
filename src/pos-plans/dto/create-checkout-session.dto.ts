import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class CreateCheckoutSessionDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  planId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  successUrl: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  cancelUrl: string;
}
