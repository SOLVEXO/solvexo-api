import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ChatHoursDayDto {
  @IsInt() @Min(0) @Max(6)
  day: number;

  @IsBoolean()
  open: boolean;

  @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  from: string;

  @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  to: string;
}

export class QuickReplyDto {
  @IsString() @MaxLength(40)
  title: string;

  @IsString() @MaxLength(1000)
  text: string;
}

/** Every field is optional; an empty string clears a text field back to its default. */
export class UpdateStoreChatSettingsDto {
  @IsOptional() @IsString() @MaxLength(500)
  avatarUrl?: string;

  @IsOptional() @IsString() @MaxLength(60)
  name?: string;

  @IsOptional() @IsString() @MaxLength(80)
  statusLine?: string;

  @IsOptional() @IsString() @MaxLength(300)
  greeting?: string;

  @IsOptional() @IsBoolean()
  autoReplyEnabled?: boolean;

  @IsOptional() @IsString() @MaxLength(500)
  autoReplyText?: string;

  @IsOptional() @IsBoolean()
  autoReplyOnlyOutsideHours?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => ChatHoursDayDto)
  hours?: ChatHoursDayDto[];

  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => QuickReplyDto)
  quickReplies?: QuickReplyDto[];
}
