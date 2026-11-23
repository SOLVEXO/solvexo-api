import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from './services/email.service';
import { escapeEmailText, notificationEmailShell, solvexoEmail } from '../notifications/templates/notification-email.template';

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
    // A store's buyer gets the store's brand; a seller or admin gets Solvexo's.
    const code = escapeEmailText(otp);
    const body = `<p>Use this code to continue. It expires in a few minutes.</p><div class="code">${code}</div><p class="muted">If you didn't ask for this code, you can ignore this email. Never share it with anyone.</p>`;
    const store = sender?.fromName?.trim();
    const html = store
      ? notificationEmailShell('Your verification code', body, undefined, { name: store, hideReceivingNotice: true })
      : solvexoEmail('Your verification code', body, { note: null });
    const ok = await this.emailService.sendMail(
      toEmail,
      `Your ${store || process.env.APP_NAME || 'Solvexo'} verification code`,
      html,
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
