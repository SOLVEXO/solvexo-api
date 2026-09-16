/* eslint-disable prettier/prettier */
import { PlatformHealthService } from './platform-health.service';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { HealthCheckService } from '@nestjs/terminus';

// Phase 10 — Platform Health. Focus: (1) never fabricates uptime/latency/
// error-rate from business data — every number here traces back to a real
// dependency ping, a real WebhookEvent.status count, or a real live
// Queue.getJobCounts() call: (2) the webhook-failure-rate math is correct
// and the disclosure note names exactly which webhook path it covers.

function buildQueue(counts: Record<string, number> | null = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }) {
  return {
    getJobCounts: jest.fn().mockImplementation(async () => {
      if (counts === null) throw new Error('redis unreachable');
      return counts;
    }),
  } as any;
}

describe('PlatformHealthService', () => {
  let service: PlatformHealthService;
  let webhookEventModel: any;
  let db: DatabaseService;
  let redis: RedisService;
  let health: HealthCheckService;
  let mongoose: any;
  let stripeWebhooksQueue: any;

  beforeEach(() => {
    webhookEventModel = { aggregate: jest.fn().mockResolvedValue([]) };
    db = { repositories: { webhookEventModel } } as any;
    redis = { isConnected: true } as any;
    health = { check: jest.fn().mockResolvedValue({ details: { mongodb: { status: 'up' } } }) } as any;
    mongoose = { pingCheck: jest.fn() };
    stripeWebhooksQueue = buildQueue();

    service = new PlatformHealthService(
      db,
      redis,
      health,
      mongoose,
      stripeWebhooksQueue,
      buildQueue(),
      buildQueue(),
      buildQueue(),
      buildQueue(),
      buildQueue(),
      buildQueue(),
    );
  });

  describe('dependency status — real, live checks only', () => {
    it('reports both dependencies up when the real Mongo ping succeeds and Redis is connected', async () => {
      const result = await service.getPlatformHealth({});
      expect(result.data.dependencyStatus.mongodb).toBe('up');
      expect(result.data.dependencyStatus.redis).toBe('up');
      expect(result.data.dependencyStatus.checkedAt).toBeInstanceOf(Date);
    });

    it('reports mongodb down (not a thrown error) when the Terminus check fails, reading the real detail off the exception', async () => {
      health.check = jest.fn().mockRejectedValue({ response: { details: { mongodb: { status: 'down' } } } });
      const result = await service.getPlatformHealth({});
      expect(result.data.dependencyStatus.mongodb).toBe('down');
      expect(result.success).toBe(true); // never throws to the caller over a real down dependency
    });

    it('reflects a disconnected Redis exactly as RedisService reports it — never independently guessed', async () => {
      // RedisService.isConnected is a real getter now (backed by a private
      // `_isConnected`), not a plain writable property — the test double
      // is typed `any` specifically so this reassignment still works.
      (redis as any).isConnected = false;
      const result = await service.getPlatformHealth({});
      expect(result.data.dependencyStatus.redis).toBe('down');
    });
  });

  describe('webhook reliability — real WebhookEvent.status counts, one specific webhook path only', () => {
    it('computes a real failure rate from actual status counts', async () => {
      webhookEventModel.aggregate.mockResolvedValue([
        { _id: 'processed', count: 18 },
        { _id: 'failed', count: 2 },
      ]);

      const result = await service.getPlatformHealth({});
      expect(result.data.webhookReliability.totalEvents).toBe(20);
      expect(result.data.webhookReliability.failedEvents).toBe(2);
      expect(result.data.webhookReliability.failureRatePercent).toBeCloseTo(10, 1);
    });

    it('returns zero, not NaN/throw, when there are no webhook events in the period', async () => {
      const result = await service.getPlatformHealth({});
      expect(result.data.webhookReliability.totalEvents).toBe(0);
      expect(result.data.webhookReliability.failureRatePercent).toBe(0);
    });

    it('discloses exactly which webhook path this covers and never claims coverage of the others', async () => {
      const result = await service.getPlatformHealth({});
      const note = result.data.webhookReliability.note;
      expect(note).toContain('subscription-billing Stripe webhook');
      expect(note).toContain('regional payment-gateway webhooks');
    });
  });

  describe('queue backlog — real, live BullMQ job counts', () => {
    it('reports the real getJobCounts() result per queue, not a fabricated value', async () => {
      stripeWebhooksQueue.getJobCounts.mockResolvedValue({ waiting: 3, active: 1, completed: 500, failed: 2, delayed: 0 });
      const result = await service.getPlatformHealth({});
      const row = result.data.queueBacklog.find((q: any) => q.name === 'Stripe Webhooks');
      expect(row).toEqual({ name: 'Stripe Webhooks', waiting: 3, active: 1, completed: 500, failed: 2, delayed: 0 });
    });

    it('marks a queue unavailable rather than reporting a fabricated zero when getJobCounts() throws', async () => {
      stripeWebhooksQueue.getJobCounts.mockRejectedValue(new Error('redis unreachable'));
      const result = await service.getPlatformHealth({});
      const row = result.data.queueBacklog.find((q: any) => q.name === 'Stripe Webhooks');
      expect(row).toBeDefined();
      expect(row?.unavailable).toBe(true);
      expect(row?.waiting).toBeNull();
    });
  });

  it('never claims latency or an aggregate application error rate — no APM tool exists in this codebase', async () => {
    const result = await service.getPlatformHealth({});
    expect(result.data).not.toHaveProperty('latency');
    expect(result.data).not.toHaveProperty('errorRate');
    expect(result.data.note.toLowerCase()).toContain('no apm');
  });
});
