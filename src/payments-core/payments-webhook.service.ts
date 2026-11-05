/* eslint-disable prettier/prettier */
import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { PaymentsCoreService, PAYMENT_LEASE_MS } from './payments-core.service';
import { BUSY } from '../common/job-lease/job-lease.service';
import { ProviderOutcome, WebhookReplayError, WebhookSignatureError } from './payment-provider.interface';
import {
  PaymentWebhookInbox, PaymentWebhookInboxDocument, PaymentWebhookOutcome, PaymentWebhookOutcomeDocument,
} from './schemas/payments.schemas';

export const MAX_WEBHOOK_ATTEMPTS = 8;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 10 * 60 * 1000;
const RETRY_LOOKBACK_MS = 24 * 3600 * 1000;

/**
 * Webhook intake. The order is deliberate:
 *   1. verify the signature over the RAW body (and the replay window) — a bad one is a 401 and writes nothing;
 *   2. write the verified notification to the inbox (durable, unique per provider event id) — from this point the answer is ALWAYS 2xx;
 *   3. process it; any error is recorded as an `error` outcome and the retry job (`retryPending`) tries again with backoff,
 *      so a processing failure can never lose a notification and never makes the provider re-send forever.
 */
@Injectable()
export class PaymentsWebhookService {
  private readonly logger = new Logger(PaymentsWebhookService.name);

  constructor(
    private readonly core: PaymentsCoreService,
    @InjectModel(PaymentWebhookInbox.name) readonly inbox: Model<PaymentWebhookInboxDocument>,
    @InjectModel(PaymentWebhookOutcome.name) readonly outcomes: Model<PaymentWebhookOutcomeDocument>,
  ) {}

  async receive(providerKey: string, rawBody: Buffer, headers: Record<string, any>, now = new Date()): Promise<{ received: true; duplicate: boolean }> {
    let provider;
    try { provider = this.core.provider(providerKey); } catch { throw new NotFoundException(); }

    let outcome: ProviderOutcome;
    try {
      outcome = provider.verifyWebhook(rawBody, headers, now);
    } catch (e: any) {
      if (e instanceof WebhookSignatureError || e instanceof WebhookReplayError) {
        this.logger.warn(`[payment-webhook-rejected] provider=${providerKey} reason=${e.name}`);
        throw new UnauthorizedException({ code: e instanceof WebhookReplayError ? 'WEBHOOK_REPLAY' : 'WEBHOOK_BAD_SIGNATURE', message: 'Webhook rejected' });
      }
      throw e;
    }
    if (!outcome.providerEventId) throw new UnauthorizedException({ code: 'WEBHOOK_NO_EVENT_ID', message: 'Webhook rejected' });

    let row: any; let duplicate = false;
    try {
      [row] = await this.inbox.create([{
        providerKey, providerEventId: outcome.providerEventId, rawDigest: createHash('sha256').update(rawBody).digest('hex'),
        outcome: { ...outcome, occurredAt: outcome.occurredAt.toISOString() },
      }]);
    } catch (e: any) {
      if (e?.code !== 11000) throw e; // could not write durably → let the provider retry (5xx)
      duplicate = true;
      row = await this.inbox.findOne({ providerKey, providerEventId: outcome.providerEventId }).lean();
    }
    // A duplicate whose first delivery already succeeded does nothing; one whose first delivery errored is retried right away.
    await this.processInboxRow(row).catch((e) => this.logger.error(`webhook processing threw outside its guard: ${e?.message}`));
    return { received: true, duplicate };
  }

  /** Processes one inbox row, recording the result. Never throws for a business/data problem (those become `error` outcomes). */
  async processInboxRow(row: any): Promise<'processed' | 'ignored' | 'error' | 'dead' | 'skipped'> {
    // one processor per inbox row at a time (webhook request vs retry job vs another server); the row's outcome log decides what is left to do
    const r = await this.core.leases.withLease(`payments:inbox:${row._id}`, PAYMENT_LEASE_MS, () => this.processInboxRowLocked(row));
    return r === BUSY ? 'skipped' : r;
  }

  private async processInboxRowLocked(row: any): Promise<'processed' | 'ignored' | 'error' | 'dead' | 'skipped'> {
    const inboxId = String(row._id);
    const done = await this.outcomes.findOne({ inboxId, result: { $in: ['processed', 'ignored', 'dead'] } }).lean();
    if (done) return 'skipped';
    const attempt = (await this.outcomes.countDocuments({ inboxId, result: 'error' })) + 1;
    try {
      const o = row.outcome;
      const outcome: ProviderOutcome = { ...o, occurredAt: new Date(o.occurredAt) };
      const intent: any = await this.core.intents.findOne({ providerKey: row.providerKey, providerRef: outcome.providerRef }).lean();
      if (!intent) throw new Error('intent_not_found');
      const r = await this.core.applyOutcome(intent, outcome, 'webhook');
      // another instance is applying an outcome to this payment right now: that is not a failure. Record nothing and leave the row
      // un-finished — the next retry pass picks it up (a 'busy' collision must not burn an attempt or lengthen the backoff).
      if (r.busy) return 'skipped';
      const result = r.wrote ? 'processed' : 'ignored';
      await this.outcomes.create([{ inboxId, result, attempt, error: null }]);
      return result;
    } catch (e: any) {
      const dead = attempt >= MAX_WEBHOOK_ATTEMPTS;
      await this.outcomes.create([{ inboxId, result: dead ? 'dead' : 'error', attempt, error: String(e?.message ?? e).slice(0, 300) }]);
      if (dead) this.logger.error(`[payment-webhook-dead] inbox=${inboxId} provider=${row.providerKey} event=${row.providerEventId} error=${e?.message}`);
      return dead ? 'dead' : 'error';
    }
  }

  /** The retry queue: inbox rows from the last 24 h with no final outcome, whose backoff has elapsed. Safe to run on several servers. */
  async retryPending(now = new Date(), limit = 100): Promise<number> {
    const since = new Date(now.getTime() - RETRY_LOOKBACK_MS);
    const rows: any[] = await this.inbox.find({ receivedAt: { $gte: since } }).sort({ receivedAt: 1 }).limit(500).lean();
    if (!rows.length) return 0;
    const ids = rows.map((r) => String(r._id));
    const outs: any[] = await this.outcomes.find({ inboxId: { $in: ids } }).sort({ at: 1 }).lean();
    const byInbox = new Map<string, any[]>();
    for (const o of outs) byInbox.set(o.inboxId, [...(byInbox.get(o.inboxId) ?? []), o]);
    let n = 0;
    for (const row of rows) {
      if (n >= limit) break;
      const list = byInbox.get(String(row._id)) ?? [];
      if (list.some((o) => o.result !== 'error')) continue;
      const errors = list.length;
      const last = list[list.length - 1];
      const wait = Math.min(RETRY_BASE_MS * 2 ** errors, RETRY_MAX_MS);
      const since0 = last ? new Date(last.at).getTime() : new Date(row.receivedAt).getTime();
      if (now.getTime() - since0 < wait) continue;
      await this.processInboxRow(row);
      n++;
    }
    return n;
  }
}
