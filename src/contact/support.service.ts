import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ContactSubmission, ContactSubmissionDocument } from './schemas/contact-submission.schema';
import { CreateSupportRequestDto } from './dto/support.dto';
import { DatabaseService } from '../database/databaseservice';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { tierFromLimits } from './support.util';

/** A store can have this many unresolved help requests at once (stops the inbox being flooded). */
export const MAX_OPEN_REQUESTS_PER_STORE = 20;
const MAX_LIMIT = 50;

@Injectable()
export class SupportService {
  constructor(
    @InjectModel(ContactSubmission.name)
    private readonly contactModel: Model<ContactSubmissionDocument>,
    private readonly databaseService: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly activityLog?: ActivityLogService,
  ) {}

  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  private get sellerModel() {
    return this.databaseService.repositories.sellerModel;
  }

  /** The support tier of this store, from its plan. Never from the client. */
  async tierForStore(storeId: string) {
    return tierFromLimits(await this.entitlements.getLimits(storeId));
  }

  async create(storeId: string, user: any, sellerId: string, dto: CreateSupportRequestDto) {
    const store: any = await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);

    const open = await this.contactModel.countDocuments({ storeId, source: 'seller', status: { $ne: 'resolved' } });
    if (open >= MAX_OPEN_REQUESTS_PER_STORE) {
      throw new BadRequestException('You already have many open requests. Please wait for a reply before sending more.');
    }

    const seller: any = await this.sellerModel.findById(sellerId).select('name email').lean();
    const email = String(user?.email ?? seller?.email ?? '').trim().toLowerCase();
    if (!email) throw new BadRequestException('Your account has no email address to reply to.');
    const name = String(user?.name ?? seller?.name ?? email).trim().slice(0, 120) || email;

    const tier = await this.tierForStore(storeId);
    const subject = dto.subject.trim();
    const message = dto.message.trim();
    if (!subject || !message) throw new BadRequestException('Write a subject and a message.');

    const doc = await this.contactModel.create({
      name,
      email,
      topic: subject,
      message,
      source: 'seller',
      tier,
      category: dto.category,
      storeId,
      sellerId,
      requesterId: String(user?.userId ?? sellerId),
    });

    this.notifications
      .notifyAdmins({
        type: NOTIFICATION_TYPES.ADMIN_CONTACT_MESSAGE,
        title: tier === 'standard' ? 'New help request from a store' : `New ${tier} help request from a store`,
        body: `${store.name ?? 'A store'}: "${subject}"`,
        data: { link: '/admin/content', tier, storeId },
      })
      .catch(() => undefined);

    this.activityLog
      ?.log({
        storeId,
        category: 'settings',
        action: 'support_request_created',
        description: `Help request sent to Solvexo: ${subject}`,
        actorId: String(user?.userId ?? sellerId),
        actorName: name,
        actorRole: user?.role ?? 'seller',
        targetId: String(doc._id),
        targetType: 'support_request',
      })
      ?.catch?.(() => undefined);

    return { success: true, data: this.toView(doc.toObject ? doc.toObject() : doc) };
  }

  async list(storeId: string, sellerId: string, opts: { page?: number; limit?: number }) {
    await verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit)) || 10));
    const page = Math.max(1, Math.floor(Number(opts.page)) || 1);
    const filter = { storeId, source: 'seller' };
    const [rows, total, tier] = await Promise.all([
      this.contactModel
        .find(filter)
        .select('topic message category status tier createdAt replies')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.contactModel.countDocuments(filter),
      this.tierForStore(storeId),
    ]);
    return { items: rows.map((r: any) => this.toView(r)), total, page, limit, tier };
  }

  /** Explicit projection: nothing but what the store itself wrote or was answered. */
  private toView(r: any) {
    return {
      _id: String(r._id),
      subject: r.topic,
      message: r.message,
      category: r.category ?? 'other',
      status: r.status,
      tier: r.tier ?? 'standard',
      createdAt: r.createdAt,
      replies: (r.replies ?? []).map((x: any) => ({ message: x.message, sentAt: x.sentAt, sentBy: x.sentBy })),
    };
  }
}
