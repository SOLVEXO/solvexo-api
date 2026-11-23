/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { NewsletterModule } from '../newsletter/newsletter.module';
import { PublicSignupFormsController, SignupFormsController } from './signup-forms.controller';
import { SignupFormsService } from './signup-forms.service';

// AuthModule + RedisModule: JwtAuthGuard (same note as CustomerSegmentsModule). NewsletterModule: a submission joins the store's list.
@Module({
  imports: [AuthModule, RedisModule, NewsletterModule],
  controllers: [PublicSignupFormsController, SignupFormsController],
  providers: [SignupFormsService],
})
export class SignupFormsModule {}
