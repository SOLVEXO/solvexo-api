import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ContactSubmission,
  ContactSubmissionSchema,
} from './schemas/contact-submission.schema';
import { ContactService } from './contact.service';
import { ContactController } from './contact.controller';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { EmailService } from '../otp/services/email.service';
import { RedisModule } from '../redis/redis.module';
import { SalesOpsModule } from '../sales-ops/sales-ops.module';

@Module({
  imports: [
    RedisModule,
    SalesOpsModule,
    MongooseModule.forFeature([
      { name: ContactSubmission.name, schema: ContactSubmissionSchema },
    ]),
  ],
  controllers: [ContactController, SupportController],
  providers: [ContactService, SupportService, EmailService],
})
export class ContactModule {}
