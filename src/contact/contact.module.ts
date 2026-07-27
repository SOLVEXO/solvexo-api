import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ContactSubmission,
  ContactSubmissionSchema,
} from './schemas/contact-submission.schema';
import { ContactService } from './contact.service';
import { ContactController } from './contact.controller';
import { EmailService } from '../otp/services/email.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ContactSubmission.name, schema: ContactSubmissionSchema },
    ]),
  ],
  controllers: [ContactController],
  providers: [ContactService, EmailService],
})
export class ContactModule {}
