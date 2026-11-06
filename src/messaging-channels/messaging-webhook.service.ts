/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { MessagingMessage, MessagingMessageDocument } from './messaging.schema';
import { MessagingConsentService } from './messaging-consent.service';
import { advanceStatus, contactKey, isStopKeyword } from './messaging-rules.util';
import { mapWhatsAppWebhook } from './whatsapp-webhook.mapping';

/**
 * Applies Meta's delivery reports to the send log and honours a STOP reply immediately. The platform webhook is already signature-verified
 * (WhatsAppWebhookController) and hands the event over; the store is found through the phone number id, so a report can only touch the
 * messages of the store that owns that number.
 */
@Injectable()
export class MessagingWebhookService {
  private readonly log = new Logger(MessagingWebhookService.name);
  constructor(
    @InjectModel(MessagingMessage.name) private readonly messages: Model<MessagingMessageDocument>,
    private readonly db: DatabaseService,
    private readonly consent: MessagingConsentService,
  ) {}

  @OnEvent('whatsapp.webhook')
  async onWebhook(evt: { phoneNumberId: string | null; payload: any }) {
    try { await this.handle(evt?.payload, evt?.phoneNumberId ?? null); } catch (e: any) { this.log.warn(`WhatsApp webhook handling failed: ${e?.message}`); }
  }

  async handle(payload: any, phoneNumberId?: string | null) {
    const mapped = mapWhatsAppWebhook(payload);
    const phoneId = phoneNumberId ?? mapped.phoneNumberId;
    if (!phoneId) return { statuses: 0, optedOut: 0 };
    const integration: any = await this.db.repositories.storeIntegrationModel.findOne({ type: 'whatsapp', provider: 'whatsapp_cloud', 'config.phoneNumberId': phoneId }).select('storeId').lean();
    if (!integration) return { statuses: 0, optedOut: 0 };
    const storeId = String(integration.storeId);

    let statuses = 0;
    for (const s of mapped.statuses) {
      const msg: any = await this.messages.findOne({ storeId, providerMessageId: s.id }).select('status').lean();
      if (!msg) continue;
      const next = advanceStatus(msg.status, s.status);
      if (next === msg.status) continue;
      const now = new Date();
      const set: any = { status: next, ...(next === 'delivered' ? { deliveredAt: now } : {}), ...(next === 'read' ? { readAt: now, deliveredAt: now } : {}), ...(next === 'failed' ? { error: s.error ?? 'Delivery failed' } : {}) };
      // Conditional on the status we read: a concurrent report cannot move it backwards.
      const r = await this.messages.updateOne({ _id: msg._id, status: msg.status }, { $set: set });
      if (r.modifiedCount) statuses++;
    }

    let optedOut = 0;
    for (const m of mapped.inbound) {
      if (!isStopKeyword(m.text)) continue;
      const key = contactKey(m.from);
      if (!key) continue;
      await this.consent.optOut(storeId, 'whatsapp', m.from, 'inbound_stop');
      // Everything still waiting for this contact in this store is cancelled right now.
      await this.messages.updateMany({ storeId, channel: 'whatsapp', contactKey: key, status: { $in: ['queued', 'sending'] } }, { $set: { status: 'skipped_opted_out' } });
      optedOut++;
    }
    return { statuses, optedOut };
  }
}
