import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { htmlToPlainText } from '../common/html-to-text.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { EmailService } from '../otp/services/email.service';
import { NotificationsService } from './notifications.service';
import { NOTIFICATION_TYPES } from './notification.types';
import { resolveSafeSmtpTarget, UnsafeSmtpTargetError } from './smtp-host-guard.util';

export interface StoreSmtpInput { host: string; port: number; user: string; password?: string; fromEmail: string }

interface CachedTransport { key: string; transporter: nodemailer.Transporter; from: string; expires: number }

const TTL_MS = 5 * 60_000;
const MAX_CACHE = 200;
const TIMEOUTS = { connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000 };

/**
 * A store's own mail server for ITS customer emails (order mails, invoices, staff invites, contact replies).
 * The platform's own mails never use it. Any failure falls back to the platform sender (EmailService), so a
 * customer's mail is never lost because a seller's password expired; the seller is told instead.
 */
@Injectable()
export class StoreMailService implements OnModuleInit {
  private readonly logger = new Logger(StoreMailService.name);
  private readonly cache = new Map<string, CachedTransport>();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get settingsModel() { return this.databaseService.repositories.storeNotificationSettingsModel; }

  onModuleInit() {
    // EmailService is provided by many modules; the hook is static so every instance routes through here.
    EmailService.storeMail = {
      resolve: (storeId) => this.resolve(storeId),
      report: (storeId, ok, error) => this.report(storeId, ok, error),
    };
  }

  /** The store's transport, or null when it has none (or it is switched off / cannot be used right now). */
  async resolve(storeId: string): Promise<{ transporter: nodemailer.Transporter; from: string } | null> {
    try {
      const doc: any = await this.settingsModel.findOne({ storeId, isDelete: false }).select('smtp').lean();
      const s = doc?.smtp;
      if (!s?.enabled || !s.host || !s.user || !s.passwordEnc || !s.fromEmail) return null;
      const key = `${s.host}:${s.port}:${s.user}:${s.fromEmail}:${String(s.passwordEnc).slice(-12)}`;
      const hit = this.cache.get(storeId);
      if (hit && hit.key === key && hit.expires > Date.now()) return hit;
      const target = await resolveSafeSmtpTarget(s.host, s.port);
      const transporter = this.createTransport(target, s.port, s.user, decryptCredential(s.passwordEnc, 'INTEGRATIONS'));
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
      const entry = { key, transporter, from: s.fromEmail, expires: Date.now() + TTL_MS };
      this.cache.set(storeId, entry);
      return entry;
    } catch (err: any) {
      this.logger.warn(`Store SMTP unusable for ${storeId}: ${err?.message}`);
      return null;
    }
  }

  private createTransport(target: { ip: string; host: string }, port: number, user: string, pass: string) {
    return nodemailer.createTransport({
      host: target.ip, port, secure: port === 465, requireTLS: port !== 465,
      auth: { user, pass }, tls: { servername: target.host }, ...TIMEOUTS,
    });
  }

  /** Written after every send through a store's SMTP. The seller hears about it when sending starts failing. */
  async report(storeId: string, ok: boolean, error?: string): Promise<void> {
    try {
      if (ok) {
        await this.settingsModel.updateOne({ storeId, 'smtp.consecutiveFailures': { $gt: 0 } }, { $set: { 'smtp.consecutiveFailures': 0, 'smtp.lastError': null } });
        return;
      }
      const updated: any = await this.settingsModel.findOneAndUpdate(
        { storeId },
        { $inc: { 'smtp.consecutiveFailures': 1 }, $set: { 'smtp.lastError': String(error ?? 'Could not send').slice(0, 300), 'smtp.lastFailureAt': new Date() } },
        { new: true },
      ).select('smtp').lean();
      const n = updated?.smtp?.consecutiveFailures ?? 0;
      if (n === 1 || n === 10) await this.alertSeller(storeId);
    } catch { /* informational */ }
  }

  private async alertSeller(storeId: string) {
    const store: any = await this.databaseService.repositories.storeModel.findById(storeId).select('sellerId name').lean();
    if (!store?.sellerId) return;
    await this.notificationsService.notify({
      recipientId: String(store.sellerId), recipientRole: 'seller', storeId,
      type: NOTIFICATION_TYPES.EMAIL_SENDER_FAILING,
      title: 'Your store email is not working',
      body: 'Emails to your customers are being sent through Solvexo instead. Check your email settings under Settings → Notifications → Sender email.',
      data: { link: `/store/${storeId}/settings/notifications` },
    }).catch(() => undefined);
  }

  // ── Seller-facing settings ──────────────────────────────────────

  /** Never includes the password. */
  async getView(sellerId: string, storeId: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const doc: any = await this.settingsModel.findOne({ storeId, isDelete: false }).select('smtp').lean();
    const s = doc?.smtp;
    return {
      success: true,
      data: {
        mode: s?.enabled ? 'own' : 'solvexo',
        host: s?.host ?? '', port: s?.port ?? 587, user: s?.user ?? '', fromEmail: s?.fromEmail ?? '',
        hasPassword: !!s?.passwordEnc, verifiedAt: s?.verifiedAt ?? null,
        lastError: s?.consecutiveFailures > 0 ? s?.lastError ?? null : null, consecutiveFailures: s?.consecutiveFailures ?? 0,
      },
    };
  }

  /** Saves only after a real connection AND a real test email worked. */
  async save(sellerId: string, storeId: string, input: StoreSmtpInput, testTo: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const existing: any = await this.settingsModel.findOne({ storeId, isDelete: false }).select('smtp').lean();
    let password = input.password?.trim() ?? '';
    if (!password) {
      if (!existing?.smtp?.passwordEnc) throw new BadRequestException('Enter the password for this email account.');
      password = decryptCredential(existing.smtp.passwordEnc, 'INTEGRATIONS');
    }
    let target: { ip: string; host: string };
    try { target = await resolveSafeSmtpTarget(input.host, input.port); }
    catch (err) { throw new BadRequestException(err instanceof UnsafeSmtpTargetError ? err.message : 'Could not use that SMTP host.'); }

    const transporter = this.createTransport(target, input.port, input.user.trim(), password);
    try {
      await transporter.verify();
      await transporter.sendMail({
        from: `"${(await this.storeName(storeId)).replace(/["\r\n<>]/g, '')}" <${input.fromEmail}>`, to: testTo,
        subject: 'Your store email is connected', html: '<p>This is a test. Your store\'s customer emails will now be sent from this address.</p>',
        text: htmlToPlainText('<p>This is a test. Your store\'s customer emails will now be sent from this address.</p>'),
      });
    } catch (err: any) {
      throw new BadRequestException(`The email server did not accept these details: ${String(err?.response || err?.message || 'connection failed').slice(0, 200)}`);
    } finally {
      transporter.close();
    }

    await this.settingsModel.updateOne({ storeId }, {
      $set: {
        smtp: { enabled: true, host: target.host, port: input.port, user: input.user.trim(), fromEmail: input.fromEmail.trim(), passwordEnc: encryptCredential(password, 'INTEGRATIONS'), verifiedAt: new Date(), lastError: null, lastFailureAt: null, consecutiveFailures: 0 },
      },
    }, { upsert: true });
    this.cache.delete(storeId);
    return { success: true, message: `Connected. A test email was sent to ${testTo}.` };
  }

  /** Back to the Solvexo sender. The saved details are removed. */
  async disable(sellerId: string, storeId: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    await this.settingsModel.updateOne({ storeId }, { $set: { smtp: null } });
    this.cache.delete(storeId);
    return { success: true, message: 'Emails are sent through Solvexo again.' };
  }

  private async storeName(storeId: string): Promise<string> {
    const s: any = await this.databaseService.repositories.storeModel.findById(storeId).select('name').lean();
    return String(s?.name ?? 'Store');
  }
}
