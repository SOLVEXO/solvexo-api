import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { MembershipsService } from './memberships.service';
import { StripeMembershipProvider } from './stripe-membership.provider';

const STALE_PROCESSING_MS = 5 * 60_000;

/**
 * Receiver for the membership Stripe endpoint (its own signing secret). Signature-verified from the RAW body,
 * idempotent through the shared WebhookEvent collection (unique providerEventId, namespaced so the same Stripe
 * event delivered to another of our endpoints never blocks this one): a duplicate delivery is acknowledged and
 * skipped, a failed one is processed again when Stripe retries (we answer 5xx).
 */
@Injectable()
export class MembershipStripeWebhookService {
  private readonly logger = new Logger(MembershipStripeWebhookService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly provider: StripeMembershipProvider,
    private readonly memberships: MembershipsService,
  ) {}

  async receive(rawBody: Buffer, signature: string | undefined): Promise<{ received: true; duplicate?: boolean }> {
    if (!rawBody) throw new BadRequestException('Raw request body unavailable');
    const event = this.provider.verifyWebhook(rawBody, signature);
    const model: any = this.db.repositories.webhookEventModel;
    const id = `membership:${event.id}`;

    try {
      await model.create({ provider: 'stripe', providerEventId: id, type: event.type, status: 'received' });
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      const prev: any = await model.findOne({ providerEventId: id });
      const recentlyRunning = prev?.status === 'processing' && Date.now() - new Date(prev.updatedAt ?? 0).getTime() < STALE_PROCESSING_MS;
      if (prev && (prev.status === 'processed' || prev.status === 'ignored' || recentlyRunning)) return { received: true, duplicate: true };
      // 'failed' / stale 'processing' / 'received': go on and process it again
    }

    await model.updateOne({ providerEventId: id }, { $set: { status: 'processing' }, $inc: { processingAttempts: 1 } });
    try {
      const result = await this.memberships.applyStripeEvent(event);
      await model.updateOne({ providerEventId: id }, { $set: { status: result === 'applied' ? 'processed' : 'ignored', processedAt: new Date(), error: null } });
    } catch (err: any) {
      this.logger.error(`membership webhook ${event.type} ${event.id} failed: ${err?.message}`);
      await model.updateOne({ providerEventId: id }, { $set: { status: 'failed', error: String(err?.message ?? err).slice(0, 500) } });
      throw err; // 5xx: Stripe delivers it again
    }
    return { received: true };
  }
}
