import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ALLOWED_SMTP_PORTS } from '../smtp-host-guard.util';

export class SaveStoreSmtpDto {
  @IsString() @MinLength(3) @MaxLength(253)
  host: string;

  @IsInt() @IsIn([...ALLOWED_SMTP_PORTS])
  port: number;

  @IsString() @MinLength(1) @MaxLength(200)
  user: string;

  /** Left out when only the other details change: the saved password is kept. */
  @IsOptional() @IsString() @MaxLength(300)
  password?: string;

  @IsEmail() @MaxLength(200)
  fromEmail: string;
}
