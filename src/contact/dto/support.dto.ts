import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { SUPPORT_CATEGORIES, SupportCategory } from '../schemas/contact-submission.schema';

/** A help request from a store dashboard. The support tier is NEVER read from the body (forbidNonWhitelisted rejects it). */
export class CreateSupportRequestDto {
  @ApiProperty({ enum: SUPPORT_CATEGORIES })
  @IsIn([...SUPPORT_CATEGORIES])
  category: SupportCategory;

  @ApiProperty({ example: 'My payout has not arrived' })
  @IsString()
  @IsNotEmpty({ message: 'Subject is required' })
  @MaxLength(120)
  subject: string;

  @ApiProperty({ example: 'Tell us what is going on...' })
  @IsString()
  @IsNotEmpty({ message: 'Message is required' })
  @MaxLength(4000)
  message: string;
}

export class ReplyContactDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: 'Write your reply' })
  @MaxLength(4000)
  message: string;
}
