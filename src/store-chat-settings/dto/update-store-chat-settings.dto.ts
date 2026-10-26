import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Every field is optional; an empty string clears it back to the default. */
export class UpdateStoreChatSettingsDto {
  @IsOptional() @IsString() @MaxLength(500)
  avatarUrl?: string;

  @IsOptional() @IsString() @MaxLength(60)
  name?: string;

  @IsOptional() @IsString() @MaxLength(80)
  statusLine?: string;

  @IsOptional() @IsString() @MaxLength(300)
  greeting?: string;
}
