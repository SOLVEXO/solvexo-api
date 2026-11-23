/* eslint-disable prettier/prettier */
import { IsBoolean, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateSignupFormDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) heading?: string;
  @IsOptional() @IsString() @MaxLength(300) body?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) buttonLabel?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) successHeading?: string;
  @IsOptional() @IsString() @MaxLength(300) successMessage?: string;
  /** Empty or null removes the code. */
  @IsOptional() @IsString() @MaxLength(60) discountCode?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(3) showAfterPageViews?: number;
  @IsOptional() @IsInt() @Min(0) @Max(60) delaySeconds?: number;
  @IsOptional() @IsBoolean() exitIntent?: boolean;
  @IsOptional() @IsBoolean() teaser?: boolean;
  @IsOptional() @IsString() @MaxLength(40) teaserText?: string;
}

export class SubmitSignupFormDto {
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(254)
  email: string;
}
