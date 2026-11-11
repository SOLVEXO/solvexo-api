import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CONTACT_SOURCES,
  ContactSubmission,
  ContactSubmissionDocument,
  SUPPORT_TIERS,
} from './schemas/contact-submission.schema';
import { sortSubmissions } from './support.util';
import { DatabaseService } from '../database/databaseservice';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { textToParagraphs } from '../notifications/customer-email-template.util';
import {
  CreateContactSubmissionDto,
  UpdateContactStatusDto,
} from './dto/contact.dto';
import { EmailService } from '../otp/services/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { escapeHtml } from '../newsletter/marketing-email.util';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { SalesCaptureService } from '../sales-ops/sales-capture.service';

/** Contact Us topics that are sales conversations: these also go into Super Admin → Sales Ops. */
export const SALES_TOPICS = new Set(['Selling on Solvexo', 'General question']);

const APP_NAME = process.env.APP_NAME || 'Solvexo';

function acknowledgementEmailHtml(name: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>We got your message</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .container { background: #ffffff; border-radius: 10px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { color: #2c3e50; margin: 0; font-size: 24px; }
  .success { background: #e8f8ee; border-left: 4px solid #22c55e; padding: 15px; margin: 20px 0; border-radius: 4px; }
  .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #888; font-size: 13px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>We got your message</h1></div>
    <div class="success">Hi ${escapeHtml(name)}, thanks for reaching out to ${APP_NAME} — our support team will get back to you soon, usually within 24 hours.</div>
    <div class="footer"><p>© ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p></div>
  </div>
</body>
</html>`;
}

@Injectable()
export class ContactService {
  constructor(
    @InjectModel(ContactSubmission.name)
    private readonly contactModel: Model<ContactSubmissionDocument>,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
    @Optional() private readonly salesCapture?: SalesCaptureService,
    @Optional() private readonly databaseService?: DatabaseService,
  ) {}

  async submit(dto: CreateContactSubmissionDto) {
    const submission = await this.contactModel.create({
      name: dto.name.trim(),
      email: dto.email.trim().toLowerCase(),
      topic: dto.topic,
      message: dto.message.trim(),
    });

    this.notificationsService
      .notifyAdmins({
        type: NOTIFICATION_TYPES.ADMIN_CONTACT_MESSAGE,
        title: 'New contact message',
        body: `${submission.name} (${submission.email}) wrote about "${submission.topic}".`,
        data: { link: '/admin/content' },
      })
      .catch(() => undefined);

    if (this.salesCapture && SALES_TOPICS.has(submission.topic))
      this.salesCapture.fromContactMessage(submission).catch(() => undefined);

    this.emailService
      .sendMail(
        submission.email,
        `We got your message — ${APP_NAME}`,
        acknowledgementEmailHtml(submission.name),
      )
      .catch(() => undefined);

    return {
      success: true,
      message: "Thanks for reaching out — we'll get back to you soon.",
    };
  }

  /**
   * Admin inbox. Open items first by support tier (dedicated, priority, standard) and oldest first; resolved ones
   * follow. `tier` / `source` narrow the list; `stats` always count everything. Seller requests carry `storeName`.
   */
  async findAll(filters: { tier?: string; source?: string } = {}) {
    const all: any[] = await this.contactModel.find().lean();

    const stats = {
      new: all.filter((s) => s.status === 'new').length,
      read: all.filter((s) => s.status === 'read').length,
      resolved: all.filter((s) => s.status === 'resolved').length,
    };

    const tier = (SUPPORT_TIERS as readonly string[]).includes(String(filters.tier)) ? String(filters.tier) : null;
    const source = (CONTACT_SOURCES as readonly string[]).includes(String(filters.source)) ? String(filters.source) : null;
    const narrowed = all.filter(
      (s) =>
        (!tier || (s.tier ?? 'standard') === tier) &&
        (!source || (s.source ?? 'public') === source),
    );
    const sorted = sortSubmissions(narrowed);

    const storeIds = [...new Set(sorted.map((s) => s.storeId).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (storeIds.length && this.databaseService) {
      const stores: any[] = await this.databaseService.repositories.storeModel
        .find({ _id: { $in: storeIds } })
        .select('name')
        .lean();
      for (const st of stores) names.set(String(st._id), st.name);
    }

    const data = sorted.map((s) => ({
      ...s,
      source: s.source ?? 'public',
      tier: s.tier ?? 'standard',
      replies: s.replies ?? [],
      storeName: s.storeId ? (names.get(String(s.storeId)) ?? null) : null,
    }));

    return {
      success: true,
      count: data.length,
      stats,
      data,
    };
  }

  /**
   * An admin answers by email (platform sender, like every contact acknowledgement). For a request that came from a
   * store dashboard the owner also gets an in-app notice. The reply is kept on the message for the seller to read.
   */
  async reply(id: string, message: string, sentBy: string) {
    const text = String(message ?? '').trim();
    if (!text) throw new BadRequestException('Write your reply');
    const msg: any = await this.contactModel.findById(id).lean();
    if (!msg) throw new NotFoundException('Contact submission not found');

    const subject = `Re: ${String(msg.topic).slice(0, 150)} — ${APP_NAME}`;
    const quoted = `<blockquote style="margin:16px 0 0;padding:8px 12px;border-left:3px solid #ddd;color:#666;font-size:13px;">${textToParagraphs(String(msg.message))}</blockquote>`;
    const html = notificationEmailShell(
      escapeHtml(`Re: ${msg.topic}`),
      `${textToParagraphs(text)}<p style="color:#888;font-size:12px;margin-top:18px;">Your message:</p>${quoted}`,
    );
    const ok = await this.emailService.sendMail(String(msg.email), subject, html);
    if (!ok) throw new BadRequestException('The reply could not be emailed. Try again.');

    const updated = await this.contactModel
      .findOneAndUpdate(
        { _id: id },
        {
          $push: { replies: { message: text, sentAt: new Date(), sentBy: String(sentBy).slice(0, 80) } },
          ...(msg.status === 'new' ? { $set: { status: 'read' } } : {}),
        },
        { new: true },
      );

    if (msg.source === 'seller' && msg.sellerId) {
      this.notificationsService
        .notify({
          recipientId: String(msg.sellerId),
          recipientRole: 'seller',
          storeId: msg.storeId ?? undefined,
          type: NOTIFICATION_TYPES.SUPPORT_REPLY,
          title: 'Solvexo replied to your help request',
          body: String(msg.topic).slice(0, 160),
          data: { storeId: msg.storeId, requestId: String(msg._id) },
        })
        .catch(() => undefined);
    }

    return { success: true, data: updated };
  }

  async updateStatus(id: string, dto: UpdateContactStatusDto) {
    const submission = await this.contactModel
      .findByIdAndUpdate(id, { status: dto.status }, { new: true })
      .exec();

    if (!submission) {
      throw new NotFoundException('Contact submission not found');
    }

    return {
      success: true,
      message: 'Status updated successfully',
      data: submission,
    };
  }

  async remove(id: string) {
    const submission = await this.contactModel.findByIdAndDelete(id).exec();

    if (!submission) {
      throw new NotFoundException('Contact submission not found');
    }

    return { success: true, message: 'Submission deleted successfully' };
  }
}
