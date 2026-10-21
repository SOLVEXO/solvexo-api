/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { TextGenerationService } from '../ai-studio/providers/text-generation.service';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EmailService } from '@/otp/services/email.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import {
  CUSTOMER_EMAIL_CATALOG,
  CUSTOMER_EMAIL_EVENTS,
  CUSTOMER_EMAIL_SAMPLE_VARS,
  isCustomerEmailEvent,
  templateTags,
} from './customer-email-events';
import { renderCustomerEmail } from './customer-email-template.util';
import { pickEmailText } from './customer-email-text.util';
import { CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE, emailUiStrings } from './customer-email-locales';
import { normalizeLocale } from '@/markets/market-price.util';
import { PreviewCustomerEmailDto, UpdateStoreNotificationSettingsDto } from './dto/update-store-notification-settings.dto';

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

/** Plain text a seller may type — no line breaks in a name, no angle brackets/quotes (it ends up in a From header). */
function cleanName(v: string): string {
  return v.replace(/[\r\n"<>]/g, '').trim().slice(0, 80);
}

/**
 * Settings → Notifications → Customer notifications: per-store on/off, own subject/message, sender name,
 * reply-to and extra "New order" recipients. Resolution at send time lives in NotificationsService.buildCustomerEmail.
 */
@Injectable()
export class StoreNotificationSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly emailService: EmailService,
    private readonly ai: TextGenerationService,
  ) {}

  /** One test email per store every 10 s (a double-click / script guard; per process). */
  private static readonly testSentAt = new Map<string, number>();

  private get r() {
    return this.db.repositories;
  }

  /** Rejects a template that uses a {{tag}} the event can't fill (it would silently render empty). */
  private assertTags(event: keyof typeof CUSTOMER_EMAIL_CATALOG, text: string, field: string) {
    const allowed = CUSTOMER_EMAIL_CATALOG[event].variables;
    const unknown = templateTags(text).filter((t) => !allowed.includes(t));
    if (unknown.length) {
      throw new BadRequestException(
        `${field}: unknown placeholder ${unknown.map((t) => `{{${t}}}`).join(', ')}. Available: ${allowed.map((t) => `{{${t}}}`).join(', ')}`,
      );
    }
  }

  async get(sellerId: string, storeId: string) {
    const store = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const settings: any = await this.r.storeNotificationSettingsModel.findOne({ storeId, isDelete: false }).lean();
    const events = CUSTOMER_EMAIL_EVENTS.map((key) => {
      const def = CUSTOMER_EMAIL_CATALOG[key];
      const o = settings?.events?.[key] ?? {};
      return {
        key,
        group: def.group,
        label: def.label,
        description: def.description,
        variables: def.variables,
        resendable: def.resendable,
        canDisable: def.canDisable !== false,
        defaultSubject: def.defaultSubject,
        defaultBody: def.defaultBody,
        enabled: (o.enabled ?? def.defaultEnabled ?? true) !== false,
        subject: o.subject ?? null,
        body: o.body ?? null,
        customized: !!(o.subject || o.body),
      };
    });
    return {
      success: true,
      data: {
        senderName: settings?.senderName ?? null,
        replyToEmail: settings?.replyToEmail ?? null,
        staffOrderEmails: settings?.staffOrderEmails ?? [],
        accentColor: settings?.accentColor ?? null,
        footerText: settings?.footerText ?? null,
        showLogo: settings?.showLogo !== false,
        storeLogo: (store as any).logo ?? null,
        // Shown as a warning when the last few customer emails could not be delivered.
        deliveryWarning: (settings?.consecutiveEmailFailures ?? 0) >= 3
          ? { consecutiveFailures: settings.consecutiveEmailFailures, lastFailureAt: settings.lastEmailFailureAt ?? null }
          : null,
        storeName: (store as any).name ?? null,
        storeContactEmail: (store as any).contactEmail ?? null,
        events,
        // The seller's own text per language, and the built-in text a language falls back to (shown as the placeholder).
        eventTranslations: settings?.eventTranslations ?? {},
        defaultTranslations: CUSTOMER_EMAIL_DEFAULTS_BY_LOCALE,
      },
    };
  }

  async update(sellerId: string, storeId: string, dto: UpdateStoreNotificationSettingsDto, actor?: { id?: string; role?: string }) {
    const ownedStore: any = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const sourceLanguage = String(ownedStore?.defaultLanguage || 'en').toLowerCase();
    const $set: Record<string, any> = {};
    const $unset: Record<string, ''> = {};

    if (dto.senderName !== undefined) $set.senderName = dto.senderName ? cleanName(dto.senderName) || null : null;
    if (dto.replyToEmail !== undefined) $set.replyToEmail = dto.replyToEmail ? String(dto.replyToEmail).trim().toLowerCase() : null;
    if (dto.accentColor !== undefined) $set.accentColor = dto.accentColor ? dto.accentColor.toLowerCase() : null;
    if (dto.footerText !== undefined) $set.footerText = dto.footerText ? dto.footerText.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) || null : null;
    if (dto.showLogo !== undefined) $set.showLogo = dto.showLogo;
    if (dto.staffOrderEmails !== undefined) {
      $set.staffOrderEmails = [...new Set(dto.staffOrderEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
    }

    for (const [key, raw] of Object.entries(dto.events ?? {})) {
      if (!isCustomerEmailEvent(key)) throw new BadRequestException(`Unknown email "${key}"`);
      if (!raw || typeof raw !== 'object') throw new BadRequestException(`Invalid settings for "${key}"`);
      if (raw.enabled !== undefined) {
        if (typeof raw.enabled !== 'boolean') throw new BadRequestException(`"${key}": enabled must be true or false`);
        if (raw.enabled === false && CUSTOMER_EMAIL_CATALOG[key].canDisable === false) {
          throw new BadRequestException(`${CUSTOMER_EMAIL_CATALOG[key].label} can't be switched off`);
        }
        $set[`events.${key}.enabled`] = raw.enabled;
      }
      if (raw.reset === true) {
        $unset[`events.${key}.subject`] = '';
        $unset[`events.${key}.body`] = '';
        continue;
      }
      for (const [field, max] of [['subject', MAX_SUBJECT], ['body', MAX_BODY]] as const) {
        const v = raw[field];
        if (v === undefined) continue;
        if (v !== null && typeof v !== 'string') throw new BadRequestException(`"${key}": ${field} must be text`);
        const text = (v ?? '').trim();
        if (text.length > max) throw new BadRequestException(`"${key}": ${field} is too long (max ${max} characters)`);
        if (text) {
          this.assertTags(key, text, `${CUSTOMER_EMAIL_CATALOG[key].label} ${field}`);
          $set[`events.${key}.${field}`] = text;
        } else {
          $unset[`events.${key}.${field}`] = '';
        }
      }
    }

    for (const [key, byLocale] of Object.entries(dto.eventTranslations ?? {})) {
      if (!isCustomerEmailEvent(key)) throw new BadRequestException(`Unknown email "${key}"`);
      if (!byLocale || typeof byLocale !== 'object') throw new BadRequestException(`Invalid translations for "${key}"`);
      for (const [rawLocale, raw] of Object.entries(byLocale)) {
        const locale = normalizeLocale(rawLocale);
        if (!locale || locale === sourceLanguage) throw new BadRequestException(`"${rawLocale}" is not a language you can translate into`);
        if (!raw || typeof raw !== 'object') throw new BadRequestException(`Invalid translation for "${key}" (${locale})`);
        const path = `eventTranslations.${key}.${locale}`;
        if (raw.reset === true) {
          $unset[path] = '';
          continue;
        }
        for (const [field, max] of [['subject', MAX_SUBJECT], ['body', MAX_BODY]] as const) {
          const v = raw[field];
          if (v === undefined) continue;
          if (v !== null && typeof v !== 'string') throw new BadRequestException(`"${key}" (${locale}): ${field} must be text`);
          const text = (v ?? '').trim();
          if (text.length > max) throw new BadRequestException(`"${key}" (${locale}): ${field} is too long (max ${max} characters)`);
          if (text) {
            this.assertTags(key, text, `${CUSTOMER_EMAIL_CATALOG[key].label} (${locale}) ${field}`);
            $set[`${path}.${field}`] = text;
          } else {
            $unset[`${path}.${field}`] = '';
          }
        }
      }
    }

    const update: Record<string, any> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    if (Object.keys(update).length) {
      const write = () => this.r.storeNotificationSettingsModel.findOneAndUpdate({ storeId }, update, { upsert: true, new: true, setDefaultsOnInsert: true });
      try {
        await write();
      } catch (err: any) {
        // Two first writes for a store (e.g. a delivery-failure counter and this save) can race on the unique storeId index.
        if (err?.code !== 11000) throw err;
        await write();
      }
      this.activityLogService.log({
        storeId, category: 'settings', action: 'customer_notifications_updated',
        description: 'Customer notification settings updated',
        actorId: actor?.id, actorRole: actor?.role ?? 'seller', targetId: storeId, targetType: 'store',
      });
    }
    return this.get(sellerId, storeId);
  }

  /** Renders an email exactly as a customer would get it, with sample values — the seller's unsaved draft if given. */
  private async renderSample(store: any, storeId: string, dto: PreviewCustomerEmailDto) {
    if (!isCustomerEmailEvent(dto.event)) throw new BadRequestException('Unknown email');
    const def = CUSTOMER_EMAIL_CATALOG[dto.event];
    const settings: any = await this.r.storeNotificationSettingsModel.findOne({ storeId, isDelete: false }).lean();
    const text = pickEmailText(dto.event, normalizeLocale(dto.locale), settings, { subject: dto.subject, body: dto.body }, store?.defaultLanguage);
    const ui = emailUiStrings(text.locale);
    const subjectTpl = text.subject;
    const bodyTpl = text.body;
    this.assertTags(dto.event, subjectTpl, 'Subject');
    this.assertTags(dto.event, bodyTpl, 'Message');
    const storeName = store.name ?? 'Your store';
    const { subject, html } = renderCustomerEmail({
      subjectTemplate: subjectTpl,
      bodyTemplate: bodyTpl,
      vars: { ...CUSTOMER_EMAIL_SAMPLE_VARS, storeName },
      storeName,
      brand: { logoUrl: settings?.showLogo === false ? null : store.logo ?? null, accent: settings?.accentColor ?? null, footerText: settings?.footerText ?? null, locale: text.locale },
      cta: dto.event === 'order_shipped'
        ? { label: ui.trackPackage, url: CUSTOMER_EMAIL_SAMPLE_VARS.trackingUrl }
        : { label: ui.viewOrder, url: CUSTOMER_EMAIL_SAMPLE_VARS.orderUrl },
    });
    return {
      subject,
      html,
      fromName: String(settings?.senderName ?? '').trim() || storeName,
      replyTo: String(settings?.replyToEmail ?? '').trim() || store.contactEmail || null,
    };
  }

  /** Translates the email (in the store's own language) into `dto.locale`, keeping every {{tag}} exactly; the seller reviews it and saves. */
  async autoTranslateEmail(sellerId: string, storeId: string, dto: PreviewCustomerEmailDto) {
    const store: any = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isCustomerEmailEvent(dto.event)) throw new BadRequestException('Unknown email');
    const target = normalizeLocale(dto.locale);
    const source = String(store.defaultLanguage || 'en').toLowerCase();
    if (!target || target === source) throw new BadRequestException('Pick a language other than your store language');
    if (this.ai.providerName !== 'claude') throw new ServiceUnavailableException('Automatic translation is not switched on for this platform yet. You can still translate by hand.');
    const settings: any = await this.r.storeNotificationSettingsModel.findOne({ storeId, isDelete: false }).lean();
    const from = pickEmailText(dto.event, source, settings, undefined, source);
    let language: string = target;
    try { language = new Intl.DisplayNames(['en'], { type: 'language' }).of(target) ?? target; } catch { /* keep the code */ }
    const schema = { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'], additionalProperties: false };
    const res = await this.ai.generate({
      tier: 'standard', maxTokens: 2000, schema,
      system: `You translate a store's customer email into ${language}. Keep every {{tag}} exactly as written (same names, same count), keep line breaks, and write the way a friendly shop writes to its customers. Return only the JSON.`,
      prompt: JSON.stringify({ subject: from.subject, body: from.body }),
    }).catch(() => { throw new ServiceUnavailableException('The translation service is busy. Try again in a moment.'); });
    const subject = String(res.json?.subject ?? '').trim();
    const body = String(res.json?.body ?? '').trim();
    const tags = (t: string) => (t.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? []).map((x) => x.replace(/\s+/g, '')).sort().join('|');
    if (!subject || !body || tags(subject) !== tags(from.subject) || tags(body) !== tags(from.body)) {
      throw new ServiceUnavailableException('The translation changed the email tags. Try again, or translate by hand.');
    }
    return { success: true, data: { subject: subject.slice(0, MAX_SUBJECT), body: body.slice(0, MAX_BODY) } };
  }

  async preview(sellerId: string, storeId: string, dto: PreviewCustomerEmailDto) {
    const store: any = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    return { success: true, data: await this.renderSample(store, storeId, dto) };
  }

  /**
   * Shopify's "Send test notification": mails the sample version of one email (the seller's unsaved draft if given)
   * to the person who clicked — never to a customer. Uses the real SMTP path, sender name and reply-to.
   */
  async sendTest(sellerId: string, storeId: string, dto: PreviewCustomerEmailDto, actorEmail?: string | null) {
    const store: any = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    const built = await this.renderSample(store, storeId, dto);

    let to = String(actorEmail ?? '').trim();
    if (!to) {
      const seller: any = await this.r.sellerModel.findById(sellerId).select('email').lean();
      to = String(seller?.email ?? '').trim();
    }
    if (!to) throw new BadRequestException('Your account has no email address to send the test to.');

    const now = Date.now();
    const last = StoreNotificationSettingsService.testSentAt.get(storeId) ?? 0;
    if (now - last < 10_000) throw new BadRequestException('A test email was just sent — wait a few seconds before sending another.');
    StoreNotificationSettingsService.testSentAt.set(storeId, now);

    const ok = await this.emailService.sendMail(to, `[Test] ${built.subject}`, built.html, built.replyTo, undefined, undefined, built.fromName);
    if (!ok) {
      StoreNotificationSettingsService.testSentAt.delete(storeId); // nothing went out — allow an immediate retry
      throw new BadRequestException('The test email could not be sent. Check the platform email settings and try again.');
    }
    return { success: true, message: `Test email sent to ${to}.`, data: { to } };
  }
}
