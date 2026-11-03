/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { ContactMessageStatus } from './schemas/store-contact-message.schema';
import { EmailService } from '../otp/services/email.service';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { textToParagraphs } from '../notifications/customer-email-template.util';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A store can only answer so fast: stops the inbox being used to push mail out.
const REPLY_WINDOW_MS = 60_000;
const REPLY_MAX_PER_WINDOW = 10;
const MAX_VISITOR_MESSAGES_PER_HOUR = 100;

@Injectable()
export class StoreContactService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  private static readonly replyTimes = new Map<string, number[]>();

  private get model() { return this.databaseService.repositories.storeContactMessageModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  // ── Public ───────────────────────────────────────────────────────────────

  async submit(storeId: string, dto: CreateContactMessageDto) {
    // Honeypot: a filled hidden field means a bot — pretend it worked, store nothing.
    if (dto.website && dto.website.trim()) return { success: true, message: 'Thanks — your message was sent.' };

    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name sellerId status').lean();
    if (!store) throw new NotFoundException('Store not found');

    // A flood into one store's inbox (bots that fill the honeypot-free fields) stops here.
    const recent = await this.model.countDocuments({ storeId, createdAt: { $gte: new Date(Date.now() - 3_600_000) } });
    if (recent >= MAX_VISITOR_MESSAGES_PER_HOUR) return { success: true, message: 'Thanks — your message was sent.' };

    const doc = await this.model.create({
      storeId,
      name: dto.name,
      email: dto.email,
      phone: dto.phone?.trim() || null,
      message: dto.message,
    });

    // Tell the owner (in-app bell + email, per their notification preferences). Never fails the visitor's request.
    this.notificationsService.notify({
      recipientId: String(store.sellerId),
      recipientRole: 'seller',
      storeId,
      type: NOTIFICATION_TYPES.CONTACT_FORM_MESSAGE,
      title: `New message from ${dto.name}`,
      body: dto.message.length > 160 ? `${dto.message.slice(0, 157)}…` : dto.message,
      data: { link: `/store/${storeId}/online-store/contact-messages`, messageId: String(doc._id) },
    }).catch(() => undefined);

    return { success: true, message: 'Thanks — your message was sent.' };
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  async list(storeId: string, sellerId: string, query: { page?: number; limit?: number; status?: string }) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const page = Math.max(1, Number(query.page) || 1);
    const filter: Record<string, unknown> = { storeId };
    if (query.status === 'new' || query.status === 'read' || query.status === 'archived') filter.status = query.status;
    const [data, total, unread] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
      this.model.countDocuments({ storeId, status: 'new' }),
    ]);
    return { success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, unread };
  }

  async setStatus(storeId: string, sellerId: string, id: string, status: ContactMessageStatus) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const updated = await this.model.findOneAndUpdate({ _id: id, storeId }, { $set: { status } }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Message not found');
    return { success: true, data: updated };
  }

  async reply(storeId: string, sellerId: string, id: string, message: string, sentBy: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const text = String(message ?? '').trim();
    if (!text) throw new BadRequestException('Write your reply');
    const now = Date.now();
    const times = (StoreContactService.replyTimes.get(storeId) ?? []).filter(t => now - t < REPLY_WINDOW_MS);
    if (times.length >= REPLY_MAX_PER_WINDOW) throw new BadRequestException('You are sending replies too fast. Wait a minute and try again.');

    const msg: any = await this.model.findOne({ _id: id, storeId }).lean();
    if (!msg) throw new NotFoundException('Message not found');
    const store: any = await this.storeModel.findById(storeId).select('name logo contactEmail').lean();
    const storeName = String(store?.name ?? 'the store');
    const quoted = `<blockquote style="margin:16px 0 0;padding:8px 12px;border-left:3px solid #ddd;color:#666;font-size:13px;">${textToParagraphs(String(msg.message))}</blockquote>`;
    const html = notificationEmailShell(escapeHtml(`Re: Your message to ${storeName}`), `${textToParagraphs(text)}<p style="color:#888;font-size:12px;margin-top:18px;">Your message:</p>${quoted}`, undefined, { name: storeName, logoUrl: store?.logo ?? null });
    const ok = await this.emailService.sendMail(String(msg.email), `Re: Your message to ${storeName}`, html, store?.contactEmail ?? null, undefined, undefined, storeName, storeId);
    if (!ok) throw new BadRequestException('The reply could not be sent. Check your email settings and try again.');

    times.push(now);
    StoreContactService.replyTimes.set(storeId, times);
    const updated = await this.model.findOneAndUpdate(
      { _id: id, storeId },
      { $push: { replies: { message: text, sentAt: new Date(), sentBy: sentBy.slice(0, 80) } }, ...(msg.status === 'new' ? { $set: { status: 'read' } } : {}) },
      { new: true },
    ).lean();
    return { success: true, data: updated };
  }

  async remove(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const res = await this.model.deleteOne({ _id: id, storeId });
    if (!res.deletedCount) throw new NotFoundException('Message not found');
    return { success: true, message: 'Message deleted' };
  }
}
