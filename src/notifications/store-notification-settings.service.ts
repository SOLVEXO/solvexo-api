/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import {
  CUSTOMER_EMAIL_CATALOG,
  CUSTOMER_EMAIL_EVENTS,
  CUSTOMER_EMAIL_SAMPLE_VARS,
  isCustomerEmailEvent,
  templateTags,
} from './customer-email-events';
import { renderCustomerEmail } from './customer-email-template.util';
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
  ) {}

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
        label: def.label,
        description: def.description,
        variables: def.variables,
        resendable: def.resendable,
        canDisable: def.canDisable !== false,
        defaultSubject: def.defaultSubject,
        defaultBody: def.defaultBody,
        enabled: o.enabled !== false,
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
      },
    };
  }

  async update(sellerId: string, storeId: string, dto: UpdateStoreNotificationSettingsDto, actor?: { id?: string; role?: string }) {
    await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
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
  async preview(sellerId: string, storeId: string, dto: PreviewCustomerEmailDto) {
    const store: any = await verifyStoreOwnershipStrict(this.r.storeModel, storeId, sellerId);
    if (!isCustomerEmailEvent(dto.event)) throw new BadRequestException('Unknown email');
    const def = CUSTOMER_EMAIL_CATALOG[dto.event];
    const settings: any = await this.r.storeNotificationSettingsModel.findOne({ storeId, isDelete: false }).lean();
    const saved = settings?.events?.[dto.event] ?? {};
    const subjectTpl = (dto.subject ?? saved.subject ?? '').trim() || def.defaultSubject;
    const bodyTpl = (dto.body ?? saved.body ?? '').trim() || def.defaultBody;
    this.assertTags(dto.event, subjectTpl, 'Subject');
    this.assertTags(dto.event, bodyTpl, 'Message');
    const storeName = store.name ?? 'Your store';
    const trackingUrl = CUSTOMER_EMAIL_SAMPLE_VARS.trackingUrl;
    const { subject, html } = renderCustomerEmail({
      subjectTemplate: subjectTpl,
      bodyTemplate: bodyTpl,
      vars: { ...CUSTOMER_EMAIL_SAMPLE_VARS, storeName },
      storeName,
      brand: { logoUrl: settings?.showLogo === false ? null : store.logo ?? null, accent: settings?.accentColor ?? null, footerText: settings?.footerText ?? null },
      cta: dto.event === 'order_shipped' ? { label: 'Track your package', url: trackingUrl } : { label: 'View your order', url: CUSTOMER_EMAIL_SAMPLE_VARS.orderUrl },
    });
    return {
      success: true,
      data: {
        subject,
        html,
        fromName: String(settings?.senderName ?? '').trim() || storeName,
        replyTo: String(settings?.replyToEmail ?? '').trim() || store.contactEmail || null,
      },
    };
  }
}
