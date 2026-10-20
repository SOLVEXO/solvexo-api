/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { FirebaseAdminService } from '@/firebase/firebase.config';
import { EmailService } from '@/otp/services/email.service';
import { WhatsAppSenderService } from '@/integrations/whatsapp-sender.service';
import type { WhatsAppEvent, WhatsAppEventVars } from '@/integrations/whatsapp-events';
import { NotificationsGateway } from './notifications.gateway';
import { QUEUE_NAMES, NOTIFICATION_PUSH_JOB, NOTIFICATION_EMAIL_JOB, NOTIFICATION_WHATSAPP_JOB } from '@/queues/queue.constants';
import { NOTIFICATION_CATEGORY, NOTIFICATION_TYPES, SELLER_EMAIL_TYPES } from './notification.types';
import { notificationEmailShell } from './templates/notification-email.template';
import { escapeHtml } from '@/newsletter/marketing-email.util';
import { CUSTOMER_EMAIL_CATALOG, type CustomerEmailEvent } from './customer-email-events';
import { renderCustomerEmail, type TemplateVars } from './customer-email-template.util';
import { pickEmailText } from './customer-email-text.util';
import { emailUiStrings } from './customer-email-locales';
import { buyerEmail } from '@/common/buyer-email.util';
import { signOrderStatusToken } from '@/common/order-status-token.util';
import { storePublicUrl } from '@/newsletter/marketing-email.util';

export interface BuiltCustomerEmail {
  /** false when the seller switched this email off for the store. */
  send: boolean;
  subject: string;
  html: string;
  fromName: string | null;
  replyTo: string | null;
}

export interface NotifyParams {
  recipientId: string;
  recipientRole: 'user' | 'seller' | 'admin';
  /** The store this notification belongs to — omit for an account-wide event with no single store. */
  storeId?: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  /** Only set this when the event should also send an email — not every in-app notification warrants one.
   *  `event` (+ `vars`) marks a STORE's customer email: the store's own settings then decide whether it is sent,
   *  its text, sender name and reply-to, and the order timeline records it. `subject`/`html` are the fallback
   *  if the store's settings can't be loaded. */
  email?: { subject: string; html: string; event?: CustomerEmailEvent; vars?: TemplateVars; trackingUrl?: string | null; cta?: { label: string; url: string } | null };
  /**
   * Only set this for order-lifecycle events a store might want on
   * WhatsApp too. `storeId` picks which store's connected WhatsApp
   * integration to send from — silently skipped (not an error) if that
   * store hasn't connected one, exactly like push/email being gated by the
   * recipient's own preferences. `templateName` must already be approved in
   * that store's Meta Business Manager.
   */
  whatsapp?: { storeId: string; to: string; templateName: string; languageCode: string; bodyParams?: string[]; event?: WhatsAppEvent; vars?: WhatsAppEventVars };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly gateway: NotificationsGateway,
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly emailService: EmailService,
    private readonly whatsAppSenderService: WhatsAppSenderService,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  /**
   * Single entry point every other module calls to raise a notification.
   * Never throws — a notification failure must not break the order/payment/
   * message flow that triggered it (same invariant subscription/platform-plan
   * notifications already follow).
   */
  async notify(params: NotifyParams): Promise<void> {
    try {
      const { recipientId, recipientRole, storeId, type, title, body, data, whatsapp } = params;
      // A seller/admin alert that has no email of its own but is email-worthy gets one built from its title/body.
      const email: NotifyParams['email'] = params.email ?? this.autoAlertEmail(params) ?? undefined;
      // Preferences are stored per store (+ one account-wide row, storeId null): use the store's own
      // row when it exists, else the account-wide one.
      const prefsModel = this.databaseService.repositories.notificationPreferenceModel;
      const prefs =
        (storeId ? await prefsModel.findOne({ userId: recipientId, storeId }).lean() : null) ??
        (await prefsModel.findOne({ userId: recipientId, storeId: null }).lean());

      const category = NOTIFICATION_CATEGORY[type];
      const categoryAllowed = !category || !prefs || prefs.prefs?.[category] !== false;

      // Always persist in-app, even if push/email are muted — the inbox is the source of truth.
      const doc = await this.databaseService.repositories.notificationModel.create({
        recipientId,
        recipientRole,
        storeId: storeId ?? null,
        type,
        title,
        body,
        data: data ?? null,
      });

      this.gateway.emitNewNotification(recipientId, doc.toObject());
      const unreadCount = await this.databaseService.repositories.notificationModel.countDocuments({
        recipientId,
        isRead: false,
      });
      this.gateway.emitUnreadCount(recipientId, unreadCount);

      if (!categoryAllowed) return;

      const pushEnabled = prefs?.pushEnabled !== false;
      if (pushEnabled) {
        await this.enqueue(NOTIFICATION_PUSH_JOB, { userId: recipientId, title, body, data });
      }

      const emailEnabled = prefs?.emailEnabled !== false;
      if (email && emailEnabled) {
        const user = await this.findRecipient(recipientId, recipientRole);
        if (user?.email) {
          let subject = email.subject;
          let html = email.html;
          // Customer-facing mails go out under the STORE's name with the store's contact email as
          // reply-to (Shopify-style); seller/platform recipients keep the platform name.
          let sender: { fromName: string | null; replyTo: string | null } | null = null;
          let skip = false;
          if (email.event && recipientRole === 'user' && storeId) {
            try {
              const built = await this.buildCustomerEmail({ storeId, event: email.event, vars: email.vars ?? {}, orderId: data?.orderId, trackingUrl: email.trackingUrl, cta: email.cta });
              if (built) {
                if (!built.send) skip = true;
                else { subject = built.subject; html = built.html; sender = { fromName: built.fromName, replyTo: built.replyTo }; }
              }
            } catch (err: any) {
              this.logger.warn(`Customer email template failed (${email.event}): ${err?.message} — sending the built-in email`);
            }
          }
          if (!skip) {
            if (!sender && recipientRole === 'user' && storeId) sender = await this.findStoreSender(storeId);
            await this.enqueue(NOTIFICATION_EMAIL_JOB, {
              to: user.email,
              subject,
              html,
              ...(sender?.fromName ? { fromName: sender.fromName } : {}),
              ...(sender?.replyTo ? { replyTo: sender.replyTo } : {}),
              ...(email.event && storeId ? { timeline: { orderId: data?.orderId ? String(data.orderId) : null, event: email.event, storeId } } : {}),
            });
          }
        }
      }

      if (whatsapp) {
        await this.enqueue(NOTIFICATION_WHATSAPP_JOB, {
          storeId: whatsapp.storeId,
          to: whatsapp.to,
          templateName: whatsapp.templateName,
          languageCode: whatsapp.languageCode,
          bodyParams: whatsapp.bodyParams,
          event: whatsapp.event,
          vars: whatsapp.vars,
        });
      }
    } catch (err: any) {
      this.logger.error(`notify() failed: ${err?.message}`);
    }
  }

  /**
   * Platform → every seller broadcast (currently just AdminAnnouncementsService).
   * Deliberately NOT "call notify() once per store" — that would also queue
   * one email per store, and a seller with many stores has exactly one
   * inbox. So the in-app side fans out per STORE (one Notification each,
   * consistent with every other notification being storeId-scoped —
   * surfaces in that store's own bell/list), while email is deduped down to
   * one send per unique SELLER.
   */
  async notifyAllStores(params: { type: string; title: string; body: string; email?: { subject: string; html: string } }): Promise<{ storesNotified: number; emailsSent: number }> {
    try {
      const stores = await this.databaseService.repositories.storeModel.find({ isDelete: false }).select('_id sellerId').lean();
      if (stores.length === 0) return { storesNotified: 0, emailsSent: 0 };

      const now = new Date();
      const docs = stores.map((s: any) => ({
        recipientId: String(s.sellerId),
        recipientRole: 'seller' as const,
        storeId: String(s._id),
        type: params.type,
        title: params.title,
        body: params.body,
        data: null,
        isRead: false,
        readAt: null,
        createdAt: now,
        updatedAt: now,
      }));
      const created = await this.databaseService.repositories.notificationModel.insertMany(docs);

      const sellerIds = [...new Set(stores.map((s: any) => String(s.sellerId)))];
      for (const doc of created) this.gateway.emitNewNotification(doc.recipientId, doc.toObject());
      for (const sellerId of sellerIds) {
        const unreadCount = await this.databaseService.repositories.notificationModel.countDocuments({ recipientId: sellerId, isRead: false });
        this.gateway.emitUnreadCount(sellerId, unreadCount);
      }

      let emailsSent = 0;
      if (params.email) {
        const [prefsList, sellers] = await Promise.all([
          this.databaseService.repositories.notificationPreferenceModel.find({ userId: { $in: sellerIds } }).lean(),
          this.databaseService.repositories.sellerModel.find({ _id: { $in: sellerIds } }).select('email').lean(),
        ]);
        const prefsBySeller = new Map(prefsList.map((p: any) => [String(p.userId), p]));
        for (const seller of sellers as any[]) {
          const prefs = prefsBySeller.get(String(seller._id));
          const emailEnabled = prefs?.emailEnabled !== false;
          if (!emailEnabled || !seller.email) continue;
          await this.enqueue(NOTIFICATION_EMAIL_JOB, { to: seller.email, subject: params.email.subject, html: params.email.html });
          emailsSent++;
        }
      }

      return { storesNotified: stores.length, emailsSent };
    } catch (err: any) {
      this.logger.error(`notifyAllStores() failed: ${err?.message}`);
      return { storesNotified: 0, emailsSent: 0 };
    }
  }

  private async findStoreSender(storeId: string): Promise<{ fromName: string | null; replyTo: string | null } | null> {
    try {
      const store: any = await this.databaseService.repositories.storeModel.findById(storeId).select('name contactEmail').lean();
      if (!store) return null;
      return { fromName: store.name ?? null, replyTo: store.contactEmail ?? null };
    } catch {
      return null;
    }
  }

  private async findRecipient(recipientId: string, recipientRole: 'user' | 'seller' | 'admin'): Promise<{ email: string | null } | null> {
    if (recipientRole === 'admin') {
      const admin: any = await this.databaseService.repositories.adminModel.findById(recipientId).select('email').lean();
      return admin ? { email: admin.email ?? null } : null;
    }
    if (recipientRole === 'seller') {
      const seller: any = await this.databaseService.repositories.sellerModel.findById(recipientId).select('email').lean();
      return seller ? { email: seller.email ?? null } : null;
    }
    const buyer: any = await this.databaseService.repositories.userModel.findById(recipientId).select('email contactEmail isGuest').lean();
    // A guest's login email is synthetic/undeliverable — their real address is `contactEmail`.
    return buyer ? { email: buyerEmail(buyer) } : null;
  }

  /** Email for a seller/admin alert: title + message + a button into the dashboard. Null when the type isn't email-worthy. */
  private autoAlertEmail(params: NotifyParams): { subject: string; html: string } | null {
    const { recipientRole, type, title, body, storeId, data } = params;
    const isAdminAlert = recipientRole === 'admin';
    if (type === NOTIFICATION_TYPES.ADMIN_EMAIL_FAILURE) return null; // an email about broken email would just fail too
    if (!isAdminAlert && !(recipientRole === 'seller' && SELLER_EMAIL_TYPES.has(type))) return null;
    const base = (process.env.FRONTEND_URL || 'https://solvexo.store').replace(/\/+$/, '');
    const link = typeof data?.link === 'string' && data.link.startsWith('/') ? data.link : isAdminAlert ? '/admin' : storeId ? `/store/${storeId}` : '/seller';
    return {
      subject: title,
      html: notificationEmailShell(escapeHtml(title), `<p>${escapeHtml(body)}</p>`, { label: isAdminAlert ? 'Open admin panel' : 'Open dashboard', url: `${base}${link}` }),
    };
  }

  /**
   * Tells every platform admin (Solvexo operator): one in-app notification each (their bell) plus email/push
   * according to each admin's own preferences. Never throws.
   */
  async notifyAdmins(params: { type: string; title: string; body: string; data?: Record<string, any> & { link?: string } }): Promise<number> {
    try {
      const admins: any[] = await this.databaseService.repositories.adminModel.find({}).select('_id').lean();
      await Promise.all(admins.map((a) => this.notify({ recipientId: String(a._id), recipientRole: 'admin', ...params })));
      return admins.length;
    } catch (err: any) {
      this.logger.error(`notifyAdmins() failed: ${err?.message}`);
      return 0;
    }
  }

  // ── Store customer emails (Shopify: Settings → Notifications → Customer notifications) ──

  /**
   * Resolves one customer email for a store: the store's on/off switch, its own subject/message (or the built-in
   * default), sender name and reply-to. Never throws for "store has no settings" — that means all defaults.
   * Returns null when the store doesn't exist.
   */
  async buildCustomerEmail(args: { storeId: string; event: CustomerEmailEvent; vars: TemplateVars; orderId?: string | null; trackingUrl?: string | null; cta?: { label: string; url: string } | null; locale?: string | null }): Promise<BuiltCustomerEmail | null> {
    const repos = this.databaseService.repositories;
    const [store, settings]: [any, any] = await Promise.all([
      repos.storeModel.findById(args.storeId).select('name contactEmail slug customDomain customDomainStatus logo').lean(),
      repos.storeNotificationSettingsModel.findOne({ storeId: args.storeId, isDelete: false }).lean(),
    ]);
    if (!store) return null;

    const def = CUSTOMER_EMAIL_CATALOG[args.event];
    const override = settings?.events?.[args.event] ?? {};
    // The language is the one the buyer shopped in (stored on the order at checkout); emails with no order stay in English.
    let locale = args.locale ?? null;
    if (!locale && args.orderId && isValidObjectId(String(args.orderId))) {
      // A failed lookup must never stop the email — it just goes out in English.
      try {
        const order: any = await repos.orderModel.findById(args.orderId).select('locale').lean();
        locale = order?.locale ?? null;
      } catch {
        locale = null;
      }
    }
    const text = pickEmailText(args.event, locale, settings);
    const ui = emailUiStrings(text.locale);
    const storeName: string = store.name ?? 'the store';
    const base = storePublicUrl(store);
    const orderUrl = base && args.orderId ? `${base}/order-status/${signOrderStatusToken(String(args.orderId))}` : null;
    const trackingUrl = args.trackingUrl && /^https?:\/\//i.test(args.trackingUrl) ? args.trackingUrl : null;
    const vars: TemplateVars = { storeName, orderUrl, trackingUrl, ...args.vars, customerName: args.vars.customerName?.trim() || ui.customerFallback };
    const ctaUrl = args.event === 'order_shipped' && trackingUrl ? trackingUrl : orderUrl;
    const ctaLabel = args.event === 'order_shipped' && trackingUrl ? ui.trackPackage : ui.viewOrder;

    const { subject, html } = renderCustomerEmail({
      subjectTemplate: text.subject,
      bodyTemplate: text.body,
      vars,
      storeName,
      brand: {
        logoUrl: settings?.showLogo === false ? null : store.logo ?? null,
        accent: settings?.accentColor ?? null,
        footerText: settings?.footerText ?? null,
        locale: text.locale,
      },
      cta: args.cta?.url && /^https?:\/\//i.test(args.cta.url)
        ? { label: args.cta.label, url: args.cta.url.replace(/"/g, '%22') }
        : ctaUrl ? { label: ctaLabel, url: ctaUrl.replace(/"/g, '%22') } : null,
    });

    return {
      // Emails the seller triggers by hand (invoice) or that carry the only copy of something (gift card code) can't be switched off.
      send: def.canDisable === false ? true : (override.enabled ?? def.defaultEnabled ?? true) !== false,
      subject,
      html,
      fromName: String(settings?.senderName ?? '').trim() || storeName,
      replyTo: String(settings?.replyToEmail ?? '').trim() || store.contactEmail || null,
    };
  }

  /**
   * Sends one customer email straight away (order confirmation, "Resend" from the order page) and records the real
   * outcome on the order timeline. `force` ignores the store's off-switch (a manual resend is the seller's decision).
   */
  async sendCustomerEmail(args: { to: string; storeId: string; event: CustomerEmailEvent; vars: TemplateVars; orderId?: string | null; trackingUrl?: string | null; cta?: { label: string; url: string } | null; force?: boolean }): Promise<'sent' | 'disabled' | 'failed'> {
    try {
      const built = await this.buildCustomerEmail(args);
      if (!built) return 'failed';
      if (!built.send && !args.force) return 'disabled';
      const ok = await this.emailService.sendMail(args.to, built.subject, built.html, built.replyTo, undefined, undefined, built.fromName);
      if (args.orderId) await this.recordEmailTimeline(String(args.orderId), args.event, args.to, ok, args.storeId);
      else await this.recordDeliveryResult(args.storeId, ok);
      return ok ? 'sent' : 'failed';
    } catch (err: any) {
      this.logger.error(`sendCustomerEmail(${args.event}) failed: ${err?.message}`);
      return 'failed';
    }
  }

  /** Delivery health per store: failures in a row since the last success (shown as a warning in Customer notifications). */
  async recordDeliveryResult(storeId: string, ok: boolean): Promise<void> {
    try {
      const model = this.databaseService.repositories.storeNotificationSettingsModel;
      if (ok) await model.updateOne({ storeId, consecutiveEmailFailures: { $gt: 0 } }, { $set: { consecutiveEmailFailures: 0 } });
      else await model.updateOne({ storeId }, { $inc: { consecutiveEmailFailures: 1 }, $set: { lastEmailFailureAt: new Date() } }, { upsert: true });
    } catch { /* informational */ }
  }

  /** Order timeline (merchant-only) line for a customer email — written with the REAL outcome of the send. */
  async recordEmailTimeline(orderId: string, event: string, to: string, ok: boolean, storeId?: string): Promise<void> {
    if (storeId) await this.recordDeliveryResult(storeId, ok);
    try {
      const label = (CUSTOMER_EMAIL_CATALOG as Record<string, { label: string }>)[event]?.label ?? 'Customer';
      await this.databaseService.repositories.orderModel.updateOne(
        { _id: orderId },
        { $push: { timeline: { type: 'email', message: ok ? `${label} email sent to ${to}` : `${label} email to ${to} could not be delivered`, actorId: null, actorRole: 'system', createdAt: new Date() } } },
      );
    } catch { /* informational */ }
  }

  /** Extra "New order" recipients the seller configured (Shopify staff order notifications). Never throws. */
  async sendStaffOrderEmails(storeId: string, subject: string, html: string, exclude: string[] = []): Promise<number> {
    try {
      const settings: any = await this.databaseService.repositories.storeNotificationSettingsModel.findOne({ storeId, isDelete: false }).select('staffOrderEmails').lean();
      // The store owner already gets the same mail through notify() — never send it to them twice.
      const store: any = await this.databaseService.repositories.storeModel.findById(storeId).select('sellerId').lean();
      const owner: any = store?.sellerId ? await this.databaseService.repositories.sellerModel.findById(store.sellerId).select('email').lean() : null;
      const skip = new Set([...exclude, owner?.email].filter(Boolean).map((e) => String(e).toLowerCase()));
      const to = [...new Set<string>((settings?.staffOrderEmails ?? []).map((e: string) => String(e).toLowerCase()))].filter((e) => e && !skip.has(e));
      const results = await Promise.all(to.map((addr) => this.emailService.sendMail(addr, subject, html)));
      return results.filter(Boolean).length;
    } catch (err: any) {
      this.logger.error(`sendStaffOrderEmails() failed: ${err?.message}`);
      return 0;
    }
  }

  /**
   * WhatsApp-only order message (no in-app/push/email): used for events that already notify the customer another
   * way or not at all. The store's per-event switch decides whether anything is actually sent. Never throws.
   */
  async sendWhatsAppEvent(params: { storeId: string; to?: string | null; event: WhatsAppEvent; vars: WhatsAppEventVars }): Promise<void> {
    try {
      if (!params.to) return;
      await this.enqueue(NOTIFICATION_WHATSAPP_JOB, {
        storeId: params.storeId,
        to: params.to,
        templateName: params.event,
        languageCode: 'en_US',
        event: params.event,
        vars: params.vars,
      });
    } catch (err: any) {
      this.logger.error(`sendWhatsAppEvent() failed: ${err?.message}`);
    }
  }

  private async enqueue(jobName: string, data: Record<string, any>) {
    try {
      await this.queue.add(jobName, data);
    } catch (err: any) {
      // Redis/BullMQ unavailable — fall back to sending inline rather than silently dropping it.
      this.logger.warn(`Notifications queue unavailable (${err?.message}) — dispatching "${jobName}" inline`);
      if (jobName === NOTIFICATION_PUSH_JOB) {
        await this.firebaseAdminService.sendToUser(data.userId, { title: data.title, body: data.body, data: data.data });
      } else if (jobName === NOTIFICATION_EMAIL_JOB) {
        const ok = await this.emailService.sendMail(data.to, data.subject, data.html, data.replyTo ?? null, undefined, undefined, data.fromName ?? null);
        if (data.timeline) {
          if (data.timeline.orderId) await this.recordEmailTimeline(data.timeline.orderId, data.timeline.event, data.to, ok, data.timeline.storeId);
          else if (data.timeline.storeId) await this.recordDeliveryResult(data.timeline.storeId, ok);
        }
      } else if (jobName === NOTIFICATION_WHATSAPP_JOB) {
        await this.whatsAppSenderService.sendOrderTemplate(data.storeId, data.to, data.templateName, data.languageCode, data.bodyParams, data.event, data.vars);
      }
    }
  }

  // ── Inbox REST surface (called by NotificationsController) ────────────────

  async list(userId: string, query: { page?: string; limit?: string; unreadOnly?: string; type?: string; storeId?: string }) {
    const page = Math.max(1, parseInt(query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit as string) || 20));
    const filter: Record<string, any> = { recipientId: userId };
    if (query.unreadOnly === 'true') filter.isRead = false;
    if (query.type) filter.type = query.type;
    if (query.storeId) filter.storeId = query.storeId;

    const model = this.databaseService.repositories.notificationModel;
    const unreadFilter: Record<string, any> = { recipientId: userId, isRead: false };
    if (query.storeId) unreadFilter.storeId = query.storeId;
    const [items, total, unreadCount] = await Promise.all([
      model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      model.countDocuments(filter),
      model.countDocuments(unreadFilter),
    ]);

    return { success: true, data: { items, total, unreadCount, page, limit } };
  }

  async unreadCount(userId: string, storeId?: string) {
    const filter: Record<string, any> = { recipientId: userId, isRead: false };
    if (storeId) filter.storeId = storeId;
    const unreadCount = await this.databaseService.repositories.notificationModel.countDocuments(filter);
    return { success: true, data: { unreadCount } };
  }

  async markRead(userId: string, id: string) {
    const doc = await this.databaseService.repositories.notificationModel.findOneAndUpdate(
      { _id: id, recipientId: userId },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true },
    );
    return { success: true, data: doc };
  }

  async markAllRead(userId: string, storeId?: string) {
    const filter: Record<string, any> = { recipientId: userId, isRead: false };
    if (storeId) filter.storeId = storeId;
    await this.databaseService.repositories.notificationModel.updateMany(
      filter,
      { $set: { isRead: true, readAt: new Date() } },
    );
    return { success: true, message: 'All notifications marked as read' };
  }

  /**
   * Clears the bell/toast unread count for one conversation's worth of
   * `NEW_MESSAGE` notifications — called from `MessagingService.markSeen()`
   * so opening a thread also dismisses the notification bell badge for it,
   * not just the conversation list's own unread counter (previously two
   * independent "unread" signals that only the first one ever cleared).
   */
  async markMessageNotificationsRead(userId: string, type: string, conversationId: string) {
    const model = this.databaseService.repositories.notificationModel;
    const result = await model.updateMany(
      { recipientId: userId, type, isRead: false, 'data.conversationId': conversationId },
      { $set: { isRead: true, readAt: new Date() } },
    );
    if (result.modifiedCount > 0) {
      const unreadCount = await model.countDocuments({ recipientId: userId, isRead: false });
      this.gateway.emitUnreadCount(userId, unreadCount);
    }
  }

  async remove(userId: string, id: string) {
    await this.databaseService.repositories.notificationModel.deleteOne({ _id: id, recipientId: userId });
    return { success: true, message: 'Notification deleted' };
  }

  // ── Device tokens ───────────────────────────────────────────────────────

  async registerDeviceToken(userId: string, role: string, fcmToken: string, platform: string) {
    await this.databaseService.repositories.deviceTokenModel.findOneAndUpdate(
      { fcmToken },
      { $set: { userId, role, platform, lastUsedAt: new Date() } },
      { upsert: true },
    );
    return { success: true, message: 'Device token registered' };
  }

  async removeDeviceToken(userId: string, fcmToken: string) {
    await this.databaseService.repositories.deviceTokenModel.deleteOne({ userId, fcmToken });
    return { success: true, message: 'Device token removed' };
  }

  // ── Preferences ─────────────────────────────────────────────────────────

  // `storeId` omitted/undefined normalizes to `null` — the account-wide row
  // (every buyer, plus the seller's own cross-store pages). Inside a
  // specific store's workspace, the frontend passes that store's real id so
  // each store gets its own independent preference row (see
  // NotificationPreference.storeId's own doc comment for why).
  async getPreferences(userId: string, role: string, storeId?: string | null) {
    const scopedStoreId = storeId ?? null;
    let prefs = await this.databaseService.repositories.notificationPreferenceModel
      .findOne({ userId, storeId: scopedStoreId })
      .lean();
    if (!prefs) {
      prefs = await this.databaseService.repositories.notificationPreferenceModel.create({ userId, role, storeId: scopedStoreId });
    }
    return { success: true, data: prefs };
  }

  async updatePreferences(userId: string, role: string, dto: Record<string, any>, storeId?: string | null) {
    const scopedStoreId = storeId ?? null;
    const { pushEnabled, emailEnabled, ...prefFlags } = dto;
    const update: Record<string, any> = {};
    if (pushEnabled !== undefined) update.pushEnabled = pushEnabled;
    if (emailEnabled !== undefined) update.emailEnabled = emailEnabled;
    for (const [key, value] of Object.entries(prefFlags)) {
      if (value !== undefined) update[`prefs.${key}`] = value;
    }

    const doc = await this.databaseService.repositories.notificationPreferenceModel.findOneAndUpdate(
      { userId, storeId: scopedStoreId },
      { $set: update, $setOnInsert: { role, storeId: scopedStoreId } },
      { upsert: true, new: true },
    );
    return { success: true, data: doc };
  }
}
