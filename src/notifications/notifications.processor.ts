/* eslint-disable prettier/prettier */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FirebaseAdminService } from '@/firebase/firebase.config';
import { EmailService } from '@/otp/services/email.service';
import { WhatsAppSenderService } from '@/integrations/whatsapp-sender.service';
import { NotificationsService } from './notifications.service';
import { QUEUE_NAMES, NOTIFICATION_PUSH_JOB, NOTIFICATION_EMAIL_JOB, NOTIFICATION_WHATSAPP_JOB } from '@/queues/queue.constants';

/**
 * Dispatches queued push/email/WhatsApp jobs raised by
 * NotificationsService.notify(). Kept off the request path — a slow
 * FCM/SMTP/Graph API call never blocks the order, payment, or message flow
 * that triggered the notification.
 */
@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private readonly firebaseAdminService: FirebaseAdminService,
    private readonly emailService: EmailService,
    private readonly whatsAppSenderService: WhatsAppSenderService,
    private readonly notificationsService: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    switch (job.name) {
      case NOTIFICATION_PUSH_JOB:
        await this.firebaseAdminService.sendToUser(job.data.userId, {
          title: job.data.title,
          body: job.data.body,
          data: job.data.data,
        });
        return;
      case NOTIFICATION_EMAIL_JOB:
        {
          const ok = await this.emailService.sendMail(job.data.to, job.data.subject, job.data.html, job.data.replyTo ?? null, undefined, undefined, job.data.fromName ?? null);
          if (job.data.timeline?.orderId) {
            await this.notificationsService.recordEmailTimeline(job.data.timeline.orderId, job.data.timeline.event, job.data.to, ok, job.data.timeline.storeId);
          } else if (job.data.timeline?.storeId) {
            await this.notificationsService.recordDeliveryResult(job.data.timeline.storeId, ok);
          }
        }
        return;
      case NOTIFICATION_WHATSAPP_JOB:
        await this.whatsAppSenderService.sendOrderTemplate(
          job.data.storeId,
          job.data.to,
          job.data.templateName,
          job.data.languageCode,
          job.data.bodyParams,
          job.data.event,
          job.data.vars,
        );
        return;
      default:
        this.logger.error(`Unknown notification job "${job.name}" — dropping job ${job.id}`);
    }
  }
}
