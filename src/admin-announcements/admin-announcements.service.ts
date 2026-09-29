/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { UpdateAnnouncementStatusDto } from './dto/update-announcement-status.dto';
import { AnnouncementQueryDto } from './dto/announcement-query.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminAnnouncementsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get model() {
    return this.databaseService.repositories.announcementModel;
  }

  /** One Notification per store + at most one email per seller — see NotificationsService.notifyAllStores. */
  private async broadcast(announcement: { title: string; message: string }) {
    return this.notificationsService.notifyAllStores({
      type: NOTIFICATION_TYPES.PLATFORM_ANNOUNCEMENT,
      title: announcement.title,
      body: announcement.message,
      email: { subject: announcement.title, html: `<p>${announcement.message}</p>` },
    });
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'announcements',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      targetType: 'announcement',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async create(dto: CreateAnnouncementDto, meta: AuditMeta) {
    if (dto.status === 'scheduled' && !dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required when status is "scheduled"');
    }

    const announcement = await this.model.create({
      title: dto.title,
      message: dto.message,
      status: dto.status ?? 'draft',
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
      publishedAt: dto.status === 'published' ? new Date() : null,
      createdBy: meta.adminId,
    });

    this.log('announcement_created', `Announcement "${dto.title}" created`, meta, String(announcement._id));
    if (announcement.status === 'published') await this.broadcast(announcement);
    return { success: true, message: 'Announcement created', data: announcement };
  }

  async list(query: AnnouncementQueryDto) {
    const filter: Record<string, unknown> = { isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.search) filter.title = { $regex: query.search, $options: 'i' };

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      this.model.countDocuments(filter),
    ]);

    return { success: true, data: { items, total, page, limit } };
  }

  private async findOrThrow(id: string) {
    const announcement = await this.model.findOne({ _id: id, isDelete: false });
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement;
  }

  async update(id: string, dto: UpdateAnnouncementDto, meta: AuditMeta) {
    await this.findOrThrow(id);

    const update: Record<string, unknown> = {};
    if (dto.title !== undefined) update.title = dto.title;
    if (dto.message !== undefined) update.message = dto.message;
    if (dto.scheduledAt !== undefined) update.scheduledAt = new Date(dto.scheduledAt);

    const announcement = await this.model.findByIdAndUpdate(id, { $set: update }, { new: true });
    this.log('announcement_updated', `Announcement "${announcement!.title}" updated`, meta, id);
    return { success: true, message: 'Announcement updated', data: announcement };
  }

  async setStatus(id: string, dto: UpdateAnnouncementStatusDto, meta: AuditMeta) {
    await this.findOrThrow(id);

    if (dto.status === 'scheduled' && !dto.scheduledAt) {
      throw new BadRequestException('scheduledAt is required when status is "scheduled"');
    }

    const update: Record<string, unknown> = { status: dto.status };
    if (dto.status === 'scheduled') update.scheduledAt = new Date(dto.scheduledAt as string);
    if (dto.status === 'published') update.publishedAt = new Date();

    const announcement = await this.model.findByIdAndUpdate(id, { $set: update }, { new: true });
    this.log('announcement_status_changed', `Announcement "${announcement!.title}" set to ${dto.status}`, meta, id);
    if (dto.status === 'published') await this.broadcast(announcement!);
    return { success: true, message: `Announcement set to ${dto.status}`, data: announcement };
  }

  async remove(id: string, meta: AuditMeta) {
    const announcement = await this.findOrThrow(id);
    await this.model.findByIdAndUpdate(id, { $set: { isDelete: true } });
    this.log('announcement_deleted', `Announcement "${announcement.title}" deleted`, meta, id);
    return { success: true, message: 'Announcement deleted' };
  }

  // ─── Scheduled publish (called from SchedulerService, every 5 min) ──────
  // Same "flip to published once due" shape as activateScheduledProducts/
  // publishScheduledBlogPosts in scheduler.service.ts, plus the actual
  // broadcast fan-out those two don't need.
  async processScheduledAnnouncements(): Promise<{ processed: number }> {
    const due = await this.model.find({
      status: 'scheduled',
      scheduledAt: { $lte: new Date() },
      isDelete: false,
    });

    for (const announcement of due) {
      announcement.status = 'published';
      announcement.publishedAt = announcement.scheduledAt;
      await announcement.save();
      await this.broadcast(announcement);
    }

    return { processed: due.length };
  }
}
