/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CONTACT_MESSAGE_STATUSES, ContactMessageStatus } from '../schemas/store-contact-message.schema';

export class CreateContactMessageDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(80)
  name?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(120)
  email?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @Matches(/^\+?[\d\s().-]{5,25}$/, { message: 'Enter a valid phone number' })
  phone?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(3000)
  message?: string;

  /** The `contact_form` section the visitor used; its field list decides what is accepted. */
  @ApiProperty({ required: false }) @IsOptional() @IsString() @Matches(/^[a-f0-9]{24}$/i, { message: 'Invalid form' })
  sectionId?: string;

  /** One answer per field: `{ fieldId, value }` (value is text, or a list of choices for a multiple-choice field). */
  @ApiProperty({ required: false }) @IsOptional() @IsArray() @ArrayMaxSize(31)
  answers?: { fieldId: string; value: unknown }[];

  /** The Cloudflare Turnstile answer, when the form is protected by a CAPTCHA. */
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(2048)
  captchaToken?: string;

  /** Honeypot — real visitors never see or fill this; bots do. */
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200)
  website?: string;
}

export class UpdateContactMessageDto {
  @ApiProperty({ enum: CONTACT_MESSAGE_STATUSES }) @IsIn(CONTACT_MESSAGE_STATUSES)
  status: ContactMessageStatus;
}

export class ReplyContactMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty({ message: 'Write your reply' }) @MaxLength(5000)
  message: string;
}
