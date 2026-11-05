/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PaymentsCoreService } from './payments-core.service';
import { PaymentsWebhookService } from './payments-webhook.service';
import { isOpen, isTerminalUnpaid } from './payment-status.util';
import { paymentsConfig } from './payments-config';

/** Poll interval (ms) for an intent of this age. Providers without webhooks are polled often; webhook providers get a slow safety-net poll. */
export function pollIntervalMs(ageMs: number, expired: boolean, supportsWebhooks: boolean): number {
  const slow = supportsWebhooks ? 30_000 : 0;
  if (expired) return Math.max(slow, ageMs < 5 * 60_000 ? 30_000 : 60_000);   // late-payment watch after expiry: back off
  if (ageMs < 30_000) return Math.max(slow, 3_000);
  if (ageMs < 90_000) return Math.max(slow, 5_000);
  return Math.max(slow, 10_000);
}

/**
 * Status polling + expiry. Runs every few seconds (a no-op in tests: they call `pollOnce` directly). Stateless apart from an in-memory
 * "last polled" map used only to space the calls out; losing it (restart) just causes one extra poll. Several servers may run it: every
 * write it makes is idempotent (unique event keys).
 */
@Injectable()
export class PaymentsPollerService {
  private readonly logger = new Logger(PaymentsPollerService.name);
  private lastPolled = new Map<string, number>();
  private running = false;

  constructor(private readonly core: PaymentsCoreService, private readonly webhooks: PaymentsWebhookService) {}

  @Cron('*/3 * * * * *')
  async tick(): Promise<void> {
    if (process.env.PAYMENTS_POLLER_ENABLED === 'false' || process.env.NODE_ENV === 'test' || this.running) return;
    this.running = true;
    try { await this.pollOnce(); await this.webhooks.retryPending(); } catch (e: any) { this.logger.error(`payments tick failed: ${e?.message}`); } finally { this.running = false; }
  }

  /** One pass. Returns how many provider calls it made (for tests). */
  async pollOnce(now = new Date()): Promise<number> {
    const cfg = paymentsConfig();
    const since = new Date(now.getTime() - cfg.qrTtlSeconds * 1000 - cfg.lateWindowMs);
    const intents: any[] = await this.core.intents.find({ createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(300).lean();
    let calls = 0;
    for (const intent of intents) {
      const provider = this.core.provider(intent.providerKey);
      const { d, events } = await this.core.derived(intent, now);
      const age = now.getTime() - new Date(intent.createdAt).getTime();
      const past = now.getTime() >= new Date(intent.expiresAt).getTime();

      // 1) open charges and the late-payment watch (expired / cancelled, not yet paid)
      if (!d.confirmed && (isOpen(d.status) || isTerminalUnpaid(d.status))) {
        if (isOpen(d.status) && past) { await this.core.expireIfDue(intent, now); continue; }
        const key = String(intent._id);
        const due = (this.lastPolled.get(key) ?? 0) + pollIntervalMs(age, past || isTerminalUnpaid(d.status), provider.supportsWebhooks) <= now.getTime();
        if (!due) continue;
        this.lastPolled.set(key, now.getTime());
        calls++;
        try {
          const o = await provider.getStatus(intent.providerRef);
          if (o.kind === 'confirmed' || o.kind === 'failed' || o.kind === 'pending') await this.core.applyOutcome(intent, o, 'poll');
          else if (o.kind === 'expired' && isOpen(d.status)) await this.core.applyOutcome(intent, o, 'poll');
        } catch (e: any) { this.logger.warn(`poll failed for ${intent._id}: ${e?.message}`); }
      }

      // 2) refunds still waiting for the provider
      const open = events.filter((e: any) => e.type === 'refund_requested' && !events.some((x: any) => x.refundId === e.refundId && (x.type === 'refund_succeeded' || x.type === 'refund_failed')));
      for (const req of open) {
        calls++;
        try {
          const o = await provider.getRefundStatus(intent.providerRef, req.refundId);
          if (o) await this.core.applyOutcome(intent, o, 'poll');
        } catch (e: any) { this.logger.warn(`refund poll failed for ${intent._id}/${req.refundId}: ${e?.message}`); }
      }
    }
    if (this.lastPolled.size > 5000) this.lastPolled.clear();
    return calls;
  }
}
