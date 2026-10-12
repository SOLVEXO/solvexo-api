import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './services/email.service';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  // Goes through the shared EmailService so the OTP mail uses the same
  // SMTP_* env vars and From address as every other platform mail.
  constructor(private readonly emailService: EmailService) {}

  /** `sender` is only set for a STORE's buyer (sign-up / verify / password reset on a storefront): the
   *  mail then goes out under the store's name with its contact email as reply-to. Sellers and admins
   *  (no sender) get the platform's own name. */
  async sendOtp(toEmail: string, otp: string, sender?: { fromName?: string | null; replyTo?: string | null }): Promise<void> {
    const ok = await this.emailService.sendMail(
      toEmail,
      'Your OTP Code',
      `<p>Your OTP code is: <b>${otp}</b></p>`,
      sender?.replyTo ?? null,
      undefined,
      undefined,
      sender?.fromName ?? null,
    );
    if (!ok) {
      this.logger.error(`Failed to send OTP to ${toEmail}`);
      throw new Error('Failed to send OTP email');
    }
    this.logger.log(`OTP email sent to ${toEmail}`);
  }
}
