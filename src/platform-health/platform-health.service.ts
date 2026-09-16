/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { HealthCheckService, MongooseHealthIndicator } from '@nestjs/terminus';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { resolveDateRange } from '../analytics/utils/analytics-date.util';
import { round } from '../analytics/utils/analytics-number.util';

// Phase 10 — Platform Health. Standing rule: never compute fake
// uptime/latency/error-rate metrics from normal business-database
// analytics (e.g. deriving "uptime" from Order timestamps, or "error rate"
// from cancelled/failed orders — those are business outcomes, not system
// health). Everything this service returns comes from a genuinely
// system-level source that already exists in this codebase:
//
//  1. Live dependency status — the EXACT same real checks HealthController
//     (src/health/health.controller.ts) already exposes at /health/ready:
//     a real MongoDB ping (via Terminus's MongooseHealthIndicator) and the
//     real current Redis connection state (RedisService.isConnected). This
//     is a point-in-time snapshot ("is it up right now"), never a
//     fabricated historical uptime percentage — there is no time-series
//     store (Prometheus/DataDog/etc.) in this codebase to compute one from.
//  2. Webhook processing reliability — real counts from the ONE webhook
//     path in this codebase that actually records a processing outcome:
//     WebhookEvent (subscriptions/schemas/webhook-event.schema.ts), whose
//     `status` field is genuinely set by the BullMQ worker to
//     processed/failed/ignored as it runs (see stripe-webhook.processor.ts
//     / QueueModule's header comment on the dead-letter convention). The
//     other two webhook schemas in this codebase (StripeWebhookEvent for
//     the order/checkout webhook, IntegrationWebhookEvent for regional
//     payment gateways) are dedup-only records with no status/error field
//     at all — there is nothing there to compute a real failure rate from,
//     so they are deliberately excluded rather than guessed at.
//  3. Queue backlog — live BullMQ job counts (waiting/active/failed/
//     delayed/completed) for every registered queue, straight from Redis
//     via Queue.getJobCounts(). Also a point-in-time snapshot, not a
//     historical rate.
//
// No APM/error-tracking SaaS (Sentry, DataDog, New Relic, etc.) is wired
// into this codebase — there is no real source for HTTP-level latency or
// an aggregate application error rate, so this deliberately does not
// report either; the `note` on the returned data says so explicitly.
@Injectable()
export class PlatformHealthService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redisService: RedisService,
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    @InjectQueue(QUEUE_NAMES.STRIPE_WEBHOOKS) private readonly stripeWebhooksQueue: Queue,
    @InjectQueue(QUEUE_NAMES.SUBSCRIPTION_EMAILS) private readonly subscriptionEmailsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.SEO_SITEMAP) private readonly seoSitemapQueue: Queue,
    @InjectQueue(QUEUE_NAMES.SEO_AUDIT) private readonly seoAuditQueue: Queue,
    @InjectQueue(QUEUE_NAMES.SEO_AI) private readonly seoAiQueue: Queue,
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) private readonly notificationsQueue: Queue,
    @InjectQueue(QUEUE_NAMES.EMAIL_CAMPAIGNS) private readonly emailCampaignsQueue: Queue,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private get queues(): { label: string; queue: Queue }[] {
    return [
      { label: 'Stripe Webhooks', queue: this.stripeWebhooksQueue },
      { label: 'Subscription Emails', queue: this.subscriptionEmailsQueue },
      { label: 'SEO Sitemap', queue: this.seoSitemapQueue },
      { label: 'SEO Audit', queue: this.seoAuditQueue },
      { label: 'SEO AI', queue: this.seoAiQueue },
      { label: 'Notifications', queue: this.notificationsQueue },
      { label: 'Email Campaigns', queue: this.emailCampaignsQueue },
    ];
  }

  /** Real, live Mongo-ping + Redis-connection status — never a guessed/cached value. */
  private async getDependencyStatus() {
    let mongodb: 'up' | 'down' = 'down';
    try {
      const result = await this.health.check([() => this.mongoose.pingCheck('mongodb', { timeout: 2000 })]);
      mongodb = result.details?.mongodb?.status === 'up' ? 'up' : 'down';
    } catch (err: any) {
      // Terminus's HealthCheckService.check() throws (ServiceUnavailableException)
      // rather than returning a normal result when a check reports 'down' — the
      // per-check breakdown is still on the exception body, reached via the
      // real getResponse() API (falling back to the raw `.response` field,
      // which HttpException also happens to expose at runtime, only if
      // getResponse() itself isn't there for some reason).
      const body = typeof err?.getResponse === 'function' ? err.getResponse() : err?.response;
      mongodb = body?.details?.mongodb?.status === 'up' ? 'up' : 'down';
    }

    return {
      mongodb,
      redis: this.redisService.isConnected ? 'up' : 'down',
      checkedAt: new Date(),
    };
  }

  /** Real webhook-processing failure rate — see the header comment for exactly which webhook path this covers and why. */
  private async getWebhookReliability(from: Date, to: Date) {
    const rows = await this.r.webhookEventModel.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const byStatus = (rows as { _id: string; count: number }[]).map((r) => ({ status: r._id, count: r.count }));
    const totalEvents = byStatus.reduce((sum, r) => sum + r.count, 0);
    const failedEvents = byStatus.find((r) => r.status === 'failed')?.count ?? 0;

    return {
      totalEvents,
      failedEvents,
      failureRatePercent: totalEvents > 0 ? round((failedEvents / totalEvents) * 100) : 0,
      byStatus,
      note:
        'Covers only the subscription-billing Stripe webhook — the one webhook path in this codebase that records a real processing status (processed/failed/ignored) per event. The order/checkout Stripe webhook and the regional payment-gateway webhooks (JazzCash/Easypaisa/PayFast/Safepay) only record delivery-dedup with no status/error field, so a real failure rate cannot be computed for them and they are excluded rather than guessed at.',
    };
  }

  /** Real, LIVE BullMQ job counts — a point-in-time backlog snapshot, not a historical rate. */
  private async getQueueBacklog() {
    return Promise.all(
      this.queues.map(async ({ label, queue }) => {
        try {
          const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
          return { name: label, ...counts };
        } catch {
          // A queue whose Redis connection is momentarily unreachable should
          // show as unavailable, never as a fabricated zero.
          return { name: label, waiting: null, active: null, completed: null, failed: null, delayed: null, unavailable: true };
        }
      }),
    );
  }

  async getPlatformHealth(query: any) {
    const { from, to } = resolveDateRange(query);

    const [dependencyStatus, webhookReliability, queueBacklog] = await Promise.all([
      this.getDependencyStatus(),
      this.getWebhookReliability(from, to),
      this.getQueueBacklog(),
    ]);

    return {
      success: true,
      data: {
        dependencyStatus,
        webhookReliability,
        queueBacklog,
        note:
          'Dependency status and queue backlog are live, point-in-time snapshots (checked at request time), not historical uptime — this codebase has no time-series monitoring store to compute an uptime percentage from. There is also no APM/error-tracking tool (Sentry, DataDog, etc.) wired in, so HTTP-level latency and an aggregate application error rate are not available and are deliberately not reported here rather than estimated from business data.',
      },
    };
  }
}
