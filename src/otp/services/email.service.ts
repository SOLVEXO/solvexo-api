import { repairMojibake } from '@/common/repair-mojibake.util';
import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { EventEmitter } from 'events';
import { htmlToPlainText } from '../../common/html-to-text.util';
import {
  isDevMailSinkEnabled,
  writeDevMail,
} from '../../common/dev-mail-sink.util';

/** Every real send attempt, from every EmailService instance in the app — EmailHealthService records it for the admin Email health card and the "emails are failing" alert. */
export const emailEvents = new EventEmitter();
/** Which sender a mail went through: the platform's transactional SMTP, or the dedicated marketing service. */
export type EmailChannel = 'transactional' | 'marketing';
export interface EmailResultEvent {
  ok: boolean;
  error?: string;
  channel?: EmailChannel;
}

/** Bulk mail = mail carrying List-Unsubscribe (campaigns, newsletters, automations, abandoned carts all set it). */
export function isBulkMail(headers?: Record<string, string> | null): boolean {
  return (
    !!headers &&
    Object.keys(headers).some((k) => k.toLowerCase() === 'list-unsubscribe')
  );
}

/**
 * The dedicated marketing sender (Brevo, Amazon SES, Mailgun, SendGrid… any SMTP relay), set with MARKETING_SMTP_HOST,
 * MARKETING_SMTP_PORT, MARKETING_SMTP_USER, MARKETING_SMTP_PASSWORD and MARKETING_SMTP_FROM. Null until host, user and
 * password are all set; bulk mail then keeps going through the platform sender as before.
 */
export function marketingSmtpConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.MARKETING_SMTP_HOST?.trim(),
    user = env.MARKETING_SMTP_USER?.trim(),
    pass = env.MARKETING_SMTP_PASSWORD;
  if (!host || !user || !pass) return null;
  const port = parseInt(String(env.MARKETING_SMTP_PORT ?? ''), 10) || 587;
  return {
    host,
    port,
    user,
    pass,
    from: env.MARKETING_SMTP_FROM?.trim() || env.SMTP_FROM || user,
  };
}

/** Registered by StoreMailService: a store's own SMTP for its customer mails (see notifications/store-mail.service.ts). */
export interface StoreMailHook {
  resolve(
    storeId: string,
  ): Promise<{ transporter: nodemailer.Transporter; from: string } | null>;
  report(storeId: string, ok: boolean, error?: string): Promise<void>;
}

/** SMTP_REPLY_TO, when it is a plausible address. */
export function platformReplyTo(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.SMTP_REPLY_TO?.trim();
  return v && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : null;
}

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;
  /** The dedicated marketing sender, or null when it is not configured (see marketingSmtpConfig). */
  private marketingTransporter: nodemailer.Transporter | null = null;
  /** Set once at boot by StoreMailService; static so every EmailService instance (one per module) uses it. */
  static storeMail: StoreMailHook | null = null;

  constructor() {
    // Configure email transporter
    const port = parseInt(process.env.SMTP_PORT as string) || 587;
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      // 465 = TLS from the first byte (e.g. smtp.hostinger.com); any other port upgrades with STARTTLS and must not
      // fall back to plain text.
      secure: port === 465,
      requireTLS: port !== 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
      // nodemailer's defaults wait up to 2 minutes to connect and 10 minutes on an idle
      // socket — long enough for one dead SMTP server to stall every request that sends
      // a mail. Fail fast instead (sendMail() already turns a failure into `false`).
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    });
    const m = marketingSmtpConfig();
    if (m) {
      this.marketingTransporter = nodemailer.createTransport({
        host: m.host,
        port: m.port,
        secure: m.port === 465,
        requireTLS: m.port !== 465,
        auth: { user: m.user, pass: m.pass },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000,
      });
    }
  }

  async sendOtpEmail(
    email: string,
    otp: string,
    type: string = 'email_verification',
  ): Promise<boolean> {
    const subject = this.getEmailSubject(type);
    const html = this.getEmailTemplate(otp, type);
    return this.sendMail(email, subject, html);
  }

  /** Generic transactional email — used by any module (e.g. subscription notifications).
   *  `replyTo` lets a per-store email (e.g. an order confirmation) route a
   *  buyer's reply straight to that store's own contact address instead of
   *  the platform's shared SMTP sender — same convention as Shopify, where
   *  a store's "Store contact email" becomes the reply-to on its own
   *  customer-facing emails. Omitted (or falsy) leaves replies going to the
   *  platform sender, unchanged from before this param existed.
   *  `headers` carries extra MIME headers — marketing sends use it for
   *  List-Unsubscribe / List-Unsubscribe-Post (required by Gmail/Yahoo for
   *  bulk senders). */
  async sendMail(
    to: string,
    subject: string,
    html: string,
    replyTo?: string | null,
    headers?: Record<string, string>,
    attachments?: {
      filename: string;
      content: Buffer | string;
      contentType?: string;
    }[],
    fromName?: string | null,
    /** A store's customer mail: sent through that store's own SMTP when it has one (platform sender is the fallback).
     *  Bulk mail (campaigns, newsletters, automations, abandoned carts) deliberately does NOT pass this: it always goes through the platform sender, so a store's mailbox is never used for bulk sends. */
    storeId?: string | null,
  ): Promise<boolean> {
    subject = repairMojibake(String(subject ?? ''));
    if (fromName) fromName = repairMojibake(fromName);
    // `.invalid` is reserved (RFC 2606): placeholder addresses of Apple sign-ins that shared no email and purged
    // accounts' de-identified addresses can never receive mail — never hand them to SMTP.
    if (/\.invalid$/i.test(String(to ?? '').trim())) {
      console.warn('Skipped email to a non-deliverable (.invalid) address');
      return false;
    }
    // DEV-ONLY (NODE_ENV!=production AND DEV_OTP_LOG=true): log the mail for the local e2e stack instead of using SMTP.
    if (isDevMailSinkEnabled()) {
      writeDevMail({ to, subject, text: htmlToPlainText(html) });
      emailEvents.emit('result', { ok: true } as EmailResultEvent);
      return true;
    }
    if (storeId && EmailService.storeMail) {
      const viaStore = await this.sendThroughStore(
        storeId,
        to,
        subject,
        html,
        replyTo,
        headers,
        attachments,
        fromName,
      );
      if (viaStore) return true;
    }
    // Bulk mail goes through the dedicated marketing sender when one is configured, so a big campaign can never use up
    // the platform mailbox's sending limit or reputation that sign-up codes and order emails depend on. It does NOT fall
    // back to the platform sender on failure: the queue retries it, and transactional mail stays untouched.
    const marketing =
      isBulkMail(headers) && this.marketingTransporter
        ? marketingSmtpConfig()
        : null;
    const channel: EmailChannel = marketing ? 'marketing' : 'transactional';
    const transporter = marketing
      ? this.marketingTransporter!
      : this.transporter;
    try {
      // `fromName` = the store's name for customer-facing mails (the mailbox
      // stays the platform's sender); omitted = the platform name.
      const displayName = String(fromName || process.env.APP_NAME || 'Solvexo')
        .replace(/["\r\n<>]/g, '')
        .trim();
      const info = await transporter.sendMail({
        from: `"${displayName}" <${marketing ? marketing.from : process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to,
        subject,
        html,
        // Plain-text part alongside the HTML — HTML-only mail is a spam signal.
        text: htmlToPlainText(html),
        // The caller's reply-to (a store's contact address); else, for the platform's own mail only (no store name),
        // SMTP_REPLY_TO, so a reply to noreply@ reaches a real mailbox. A store's mail never routes replies to Solvexo.
        ...(replyTo ? { replyTo } : !fromName && !storeId && platformReplyTo() ? { replyTo: platformReplyTo()! } : {}),
        ...(headers ? { headers } : {}),
        ...(attachments?.length ? { attachments } : {}),
      });

      console.log(`✅ Email sent (${channel}):`, info.messageId);
      emailEvents.emit('result', { ok: true, channel } as EmailResultEvent);
      return true;
    } catch (error) {
      console.error(`❌ Error sending email (${channel}):`, error);
      emailEvents.emit('result', {
        ok: false,
        channel,
        error: String(error?.message ?? error).slice(0, 300),
      } as EmailResultEvent);
      return false;
    }
  }

  /** True when the store's own server accepted the mail. Any failure returns false so the platform sender can take over. */
  private async sendThroughStore(
    storeId: string,
    to: string,
    subject: string,
    html: string,
    replyTo?: string | null,
    headers?: Record<string, string>,
    attachments?: {
      filename: string;
      content: Buffer | string;
      contentType?: string;
    }[],
    fromName?: string | null,
  ): Promise<boolean> {
    const hook = EmailService.storeMail;
    if (!hook) return false;
    try {
      const t = await hook.resolve(storeId);
      if (!t) return false;
      const displayName = String(fromName || '')
        .replace(/["\r\n<>]/g, '')
        .trim();
      try {
        await t.transporter.sendMail({
          from: displayName ? `"${displayName}" <${t.from}>` : t.from,
          to,
          subject,
          html,
          text: htmlToPlainText(html),
          ...(replyTo ? { replyTo } : {}),
          ...(headers ? { headers } : {}),
          ...(attachments?.length ? { attachments } : {}),
        });
        void hook.report(storeId, true);
        return true;
      } catch (error) {
        void hook.report(storeId, false, String(error?.message ?? error));
        return false;
      }
    } catch {
      return false;
    }
  }

  private getEmailSubject(type: string): string {
    switch (type) {
      case 'email_verification':
        return 'Verify Your Email Address';
      case 'password_reset':
        return 'Reset Your Password';
      case 'login':
        return 'Your Login OTP';
      default:
        return 'Your Verification Code';
    }
  }

  private getEmailTemplate(otp: string, type: string): string {
    const appName = process.env.APP_NAME || 'Your App';
    const expiryMinutes =
      parseInt(process.env.OTP_EXPIRY_MINUTES as string) || 10;

    let title = 'Verify Your Email';
    let message = 'Please use the following code to verify your email address:';

    switch (type) {
      case 'password_reset':
        title = 'Reset Your Password';
        message = 'Please use the following code to reset your password:';
        break;
      case 'login':
        title = 'Login Verification';
        message = 'Please use the following code to complete your login:';
        break;
    }

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background: #ffffff;
            border-radius: 10px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #2c3e50;
            margin: 0;
            font-size: 28px;
        }
        .otp-box {
            background: #f8f9fa;
            border: 2px dashed #3498db;
            border-radius: 8px;
            padding: 30px;
            text-align: center;
            margin: 30px 0;
        }
        .otp-code {
            font-size: 36px;
            font-weight: bold;
            color: #3498db;
            letter-spacing: 8px;
            margin: 10px 0;
        }
        .message {
            font-size: 16px;
            color: #555;
            margin: 20px 0;
            text-align: center;
        }
        .warning {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #888;
            font-size: 14px;
        }
        .button {
            display: inline-block;
            padding: 12px 30px;
            background: #3498db;
            color: white;
            text-decoration: none;
            border-radius: 5px;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔐 ${title}</h1>
        </div>
        
        <p class="message">${message}</p>
        
        <div class="otp-box">
            <div style="font-size: 14px; color: #666; margin-bottom: 10px;">
                Your verification code is:
            </div>
            <div class="otp-code">${otp}</div>
            <div style="font-size: 14px; color: #666; margin-top: 10px;">
                Valid for ${expiryMinutes} minutes
            </div>
        </div>
        
        <div class="warning">
            <strong>⚠️ Security Notice:</strong>
            <ul style="margin: 10px 0; padding-left: 20px;">
                <li>Never share this code with anyone</li>
                <li>Our team will never ask for your OTP</li>
                <li>This code expires in ${expiryMinutes} minutes</li>
            </ul>
        </div>
        
        <p style="text-align: center; color: #666; font-size: 14px;">
            If you didn't request this code, please ignore this email or contact support if you're concerned.
        </p>
        
        <div class="footer">
            <p>© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
            <p>This is an automated email. Please do not reply.</p>
        </div>
    </div>
</body>
</html>
        `;
  }

  // Test email connection
  /** True when the marketing sender is configured (MARKETING_SMTP_*). */
  hasMarketingSender(): boolean {
    return !!this.marketingTransporter;
  }

  async testConnection(
    channel: EmailChannel = 'transactional',
  ): Promise<boolean> {
    const transporter =
      channel === 'marketing' ? this.marketingTransporter : this.transporter;
    if (!transporter) return false;
    try {
      await transporter.verify();
      console.log('✅ Email server connection verified');
      return true;
    } catch (error) {
      console.error('❌ Email server connection failed:', error);
      return false;
    }
  }
}
