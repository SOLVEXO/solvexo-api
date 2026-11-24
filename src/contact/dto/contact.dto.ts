import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ContactSubmissionStatus } from '../schemas/contact-submission.schema';

export class CreateContactSubmissionDto {
  @ApiProperty({ example: 'Jane Cooper' })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail()
  @IsNotEmpty({ message: 'Email is required' })
  email: string;

  @ApiProperty({ example: 'Order or delivery' })
  @IsString()
  @IsNotEmpty({ message: 'Topic is required' })
  topic: string;

  @ApiProperty({ example: "Tell us a bit about what's going on…" })
  @IsString()
  @IsNotEmpty({ message: 'Message is required' })
  message: string;

  /** "Send me tips and offers by email": only acted on when the message becomes a Sales Ops lead. Unticked = no change. */
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;
}

export class UpdateContactStatusDto {
  @ApiProperty({ example: 'resolved', enum: ['new', 'read', 'resolved'] })
  @IsIn(['new', 'read', 'resolved'])
  status: ContactSubmissionStatus;
}
