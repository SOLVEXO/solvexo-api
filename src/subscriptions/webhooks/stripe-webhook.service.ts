/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '@/database/databaseservice';
import { PaymentGatewayService } from '../payment-gateway/payment-gateway.service';
import { QUEUE_NAMES, STRIPE_WEBHOOK_JOB } from '@/queues/queue.constants';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly gateway: PaymentGatewayService,
    private readonly db: DatabaseService,
    @InjectQueue(QUEUE_NAMES.STRIPE_WEBHOOKS) private readonly webhookQueue: Queue,
  ) {}

  /** Dead-letter / audit view of every Stripe webhook event received, including permanently-failed jobs. */
  async adminHistory(query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter: any = {};
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;

    const model = this.db.repositories.webhookEventModel;
    const [events, total] = await Promise.all([
      model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      model.countDocuments(filter),
    ]);
    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, events } };
  }

  /** Manually re-queues a webhook event stuck in 'failed' — the dead-letter "replay" action. */
  async adminRetry(id: string) {
    const model = this.db.repositories.webhookEventModel;
    const event = await model.findById(id);
    if (!event) throw new NotFoundException('Webhook event not found');
    await model.updateOne({ _id: id }, { $set: { status: 'received' } });
    await this.webhookQueue.add(STRIPE_WEBHOOK_JOB, { eventId: event.providerEventId, type: event.type });
    return { success: true, message: 'Webhook event re-queued for processing' };
  }

  /**
   * Verifies the Stripe signature, records the event for idempotency/replay
   * protection, and enqueues it for async processing. Returns quickly so
   * Stripe never times out waiting on our actual business logic.
   */
  async receive(rawBody: Buffer, signatureHeader: string | string[] | undefined): Promise<{ received: true } | { received: true; duplicate: true }> {
    const stripe = this.gateway.stripeClient;
    if (!stripe) {
      throw new BadRequestException('Stripe is not the active payment provider');
    }
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new BadRequestException('STRIPE_WEBHOOK_SECRET is not configured');
    }
    if (!signatureHeader || Array.isArray(signatureHeader)) {
      throw new BadRequestException('Missing Stripe-Signature header');
    }

    let event: any;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
    } catch (err: any) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err?.message}`);
      throw new BadRequestException(`Webhook signature verification failed: ${err?.message}`);
    }

    const { webhookEventModel } = this.db.repositories;

    // Replay/duplicate-delivery protection — Stripe explicitly documents that
    // the same event may be delivered more than once.
    try {
      await webhookEventModel.create({
        provider: 'stripe', providerEventId: event.id, type: event.type,
        status: 'received', payload: event.data?.object ?? null,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        this.logger.log(`Duplicate Stripe webhook delivery ignored: ${event.id} (${event.type})`);
        return { received: true, duplicate: true };
      }
      throw err;
    }

    await this.webhookQueue.add(STRIPE_WEBHOOK_JOB, { eventId: event.id, type: event.type }, {
      jobId: event.id, // BullMQ-level dedupe on top of our own DB check
    });

    return { received: true };
  }
}
