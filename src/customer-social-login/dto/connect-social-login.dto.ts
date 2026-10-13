import { IsString, MaxLength, MinLength } from 'class-validator';

export class ConnectSocialLoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  clientId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  clientSecret: string;
}
