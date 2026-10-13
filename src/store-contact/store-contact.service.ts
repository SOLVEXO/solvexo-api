/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { ContactMessageStatus } from './schemas/store-contact-message.schema';

@Injectable()
export class StoreContactService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get model() { return this.databaseService.repositories.storeContactMessageModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  // ── Public ───────────────────────────────────────────────────────────────

  async submit(storeId: string, dto: CreateContactMessageDto) {
    // Honeypot: a filled hidden field means a bot — pretend it worked, store nothing.
    if (dto.website && dto.website.trim()) return { success: true, message: 'Thanks — your message was sent.' };

    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name sellerId status').lean();
    if (!store) throw new NotFoundException('Store not found');

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

  async remove(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const res = await this.model.deleteOne({ _id: id, storeId });
    if (!res.deletedCount) throw new NotFoundException('Message not found');
    return { success: true, message: 'Message deleted' };
  }
}
