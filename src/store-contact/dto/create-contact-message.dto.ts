/* eslint-disable prettier/prettier */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CONTACT_MESSAGE_STATUSES, ContactMessageStatus } from '../schemas/store-contact-message.schema';

export class CreateContactMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty({ message: 'Your name is required' }) @MaxLength(80)
  name: string;

  @ApiProperty() @IsEmail({}, { message: 'Enter a valid email address' }) @MaxLength(120)
  email: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @Matches(/^\+?[\d\s().-]{5,25}$/, { message: 'Enter a valid phone number' })
  phone?: string;

  @ApiProperty() @IsString() @IsNotEmpty({ message: 'Please write a message' }) @MaxLength(3000)
  message: string;

  /** Honeypot — real visitors never see or fill this; bots do. */
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200)
  website?: string;
}

export class UpdateContactMessageDto {
  @ApiProperty({ enum: CONTACT_MESSAGE_STATUSES }) @IsIn(CONTACT_MESSAGE_STATUSES)
  status: ContactMessageStatus;
}
