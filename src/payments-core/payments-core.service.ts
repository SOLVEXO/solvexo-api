/* eslint-disable prettier/prettier */
import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isoExponent, isSafeMinor } from '@/common/money-minor.util';
import {
  PaymentProvider, PAYMENT_PROVIDERS, ProviderOutcome,
} from './payment-provider.interface';
import {
  ONCE_PER_INTENT_TYPES, PaymentEvent, PaymentEventDocument, PaymentEventType, PaymentIntent, PaymentIntentDocument,
} from './schemas/payments.schemas';
import { derivePayment, DerivedPayment, isOpen, isTerminalUnpaid } from './payment-status.util';
import { DIGITAL_PAYMENTS_GATE, DigitalPaymentsGate } from './digital-payments-gate';
import { paymentsConfig } from './payments-config';
import { Store, StoreDocument } from '@/store/schemas/store.schema';
import { RegisterSession, RegisterSessionDocument } from '@/pos/schemas/register-session.schema';
import { Sale, SaleDocument } from '@/pos/schemas/sales.schema';
import { PosAuditLog, PosAuditLogDocument } from '@/pos/schemas/pos-audit-log.schema';

export interface PaymentActor {
  storeId: string;
  deviceId?: string | null;
  employeeId?: string | null;
  registerId?: string | null;
}

const MAX_SEQ_RETRIES = 6;

@Injectable()
export class PaymentsCoreService {
  private readonly logger = new Logger(PaymentsCoreService.name);

  constructor(
    @InjectModel(PaymentIntent.name) readonly intents: Model<PaymentIntentDocument>,
    @InjectModel(PaymentEvent.name) readonly events: Model<PaymentEventDocument>,
    @InjectModel(Store.name) private readonly stores: Model<StoreDocument>,
    @InjectModel(RegisterSession.name) private readonly sessions: Model<RegisterSessionDocument>,
    @InjectModel(Sale.name) private readonly sales: Model<SaleDocument>,
    @InjectModel(PosAuditLog.name) private readonly audit: Model<PosAuditLogDocument>,
    @Inject(PAYMENT_PROVIDERS) private readonly providers: PaymentProvider[],
    @Inject(DIGITAL_PAYMENTS_GATE) private readonly gate: DigitalPaymentsGate,
  ) {}

  provider(key: string): PaymentProvider {
    const p = this.providers.find((x) => x.key === key);
    if (!p) throw new InternalServerErrorException(`Payment provider "${key}" is not configured`);
    return p;
  }

  // ── events ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Appends one event with the next sequence number. Concurrency-safe on any number of servers: `(intentId, seq)` and `onceKey` are
   * unique, so a lost race on the sequence is retried and a lost race on a once-per-intent type returns the winner's row
   * (`created:false`). A duplicate provider event id (a replayed webhook) also returns the original row.
   */
  async appendEvent(
    intent: { _id: any; storeId: string },
    type: PaymentEventType,
    f: Partial<Pick<PaymentEvent, 'amountMinor' | 'source' | 'providerEventId' | 'providerKey' | 'refundId' | 'providerRefundRef' | 'late' | 'saleId' | 'employeeId' | 'note' | 'meta' | 'at'>> & { source: PaymentEvent['source'] },
  ): Promise<{ event: any; created: boolean }> {
    const intentId = String(intent._id);
    const onceKey = ONCE_PER_INTENT_TYPES.includes(type) ? `${intentId}:${type}` : f.refundId && type.startsWith('refund_') ? `${intentId}:${type}:${f.refundId}` : undefined;
    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      const last: any = await this.events.findOne({ intentId }).sort({ seq: -1 }).select('seq').lean();
      try {
        const [doc] = await this.events.create([{ ...f, intentId, storeId: intent.storeId, seq: (last?.seq ?? 0) + 1, type, onceKey, at: f.at ?? new Date() }]);
        return { event: doc, created: true };
      } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const kp = Object.keys(e?.keyPattern ?? {});
        if (kp.includes('seq')) continue; // lost the race for this sequence number — read again
        if (kp.includes('onceKey') && onceKey) { const ex = await this.events.findOne({ onceKey }).lean(); if (ex) return { event: ex, created: false }; }
        if (kp.includes('providerEventId') && f.providerEventId) { const ex = await this.events.findOne({ providerKey: f.providerKey, providerEventId: f.providerEventId }).lean(); if (ex) return { event: ex, created: false }; }
        throw e;
      }
    }
    throw new InternalServerErrorException('Could not append the payment event (sequence contention)');
  }

  async eventsOf(intentId: string): Promise<any[]> {
    return this.events.find({ intentId }).sort({ seq: 1 }).lean();
  }

  async derived(intent: any, now = new Date()): Promise<{ events: any[]; d: DerivedPayment }> {
    const events = await this.eventsOf(String(intent._id));
    return { events, d: derivePayment(events as any, intent.amountMinor, now, paymentsConfig().unattachedGraceMs) };
  }

  // ── create / read ──────────────────────────────────────────────────────────────────────────────────────────────

  async createIntent(
    actor: PaymentActor,
    dto: { amountMinor: number; sessionId: string; saleAttemptKey?: string | null; idempotencyKey: string; mockScenario?: string | null },
  ) {
    const cfg = paymentsConfig();
    if (!isSafeMinor(dto.amountMinor) || dto.amountMinor <= 0) throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'amountMinor must be a positive integer (minor units)' });
    if (dto.amountMinor > cfg.maxAmountMinor) throw new BadRequestException({ code: 'AMOUNT_TOO_LARGE', message: 'Amount is above the digital-payment limit' });
    if (!dto.idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotencyKey is required' });

    const prior = await this.intents.findOne({ storeId: actor.storeId, idempotencyKey: dto.idempotencyKey }).lean();
    if (prior) {
      if (prior.amountMinor !== dto.amountMinor) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This key was already used for a different amount' });
      return this.view(prior);
    }

    const { subMerchantRef } = await this.gate.assertEnabled(actor.storeId); // 403 STORE_NOT_VERIFIED — before anything is created

    const session: any = await this.sessions.findOne({ _id: dto.sessionId, storeId: actor.storeId, status: 'open' }).lean();
    if (!session) throw new BadRequestException({ code: 'NO_OPEN_SESSION', message: 'There is no open register session for this payment' });
    const store: any = await this.stores.findById(actor.storeId).select('baseCurrency').lean();
    const currency = String(store?.baseCurrency || 'USD').toUpperCase();
    const exp = isoExponent(currency);

    const provider = this.provider(cfg.providerKey);
    const ours = new Date(Date.now() + Math.min(cfg.qrTtlSeconds, provider.qrValiditySeconds) * 1000);
    const intentId = new Types.ObjectId();
    const charge = await provider.createCharge({
      intentId: String(intentId), amountMinor: dto.amountMinor, currency, currencyExponent: exp, idempotencyKey: `${actor.storeId}:${dto.idempotencyKey}`,
      subMerchantRef, description: `Solvexo POS ${actor.storeId}`, expiresAt: ours, mockScenario: dto.mockScenario ?? null,
    });
    const expiresAt = charge.expiresAt.getTime() < ours.getTime() ? charge.expiresAt : ours; // never longer than the provider's QR validity

    let intent: any;
    try {
      [intent] = await this.intents.create([{
        _id: intentId, storeId: actor.storeId, registerId: session.registerId ?? actor.registerId ?? null, sessionId: String(session._id),
        shiftId: session.shiftId ?? null, deviceId: actor.deviceId ?? null, employeeId: actor.employeeId ?? null,
        method: 'raast_qr', providerKey: provider.key, providerRef: charge.providerRef, qrPayload: charge.qrPayload, subMerchantRef,
        amountMinor: dto.amountMinor, currency, currencyExponent: exp, expiresAt, idempotencyKey: dto.idempotencyKey, saleAttemptKey: dto.saleAttemptKey ?? null,
      }]);
    } catch (e: any) {
      if (e?.code === 11000) { // two taps raced: the other request created it
        const won = await this.intents.findOne({ storeId: actor.storeId, idempotencyKey: dto.idempotencyKey }).lean();
        if (won) return this.view(won);
      }
      await provider.cancel(charge.providerRef).catch(() => undefined);
      throw e;
    }
    await this.appendEvent(intent, 'created', { source: 'system', amountMinor: dto.amountMinor, employeeId: actor.employeeId ?? undefined, meta: { providerRef: charge.providerRef } });
    return this.view(intent);
  }

  async getIntentOrThrow(storeId: string, id: string): Promise<any> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Payment not found');
    const intent: any = await this.intents.findOne({ _id: id, storeId }).lean();
    if (!intent) throw new NotFoundException('Payment not found');
    return intent;
  }

  /** What the till renders and polls. The countdown is computed from the SERVER clock (`serverTime`, `expiresAt`), never the device's. */
  async view(intent: any, now = new Date()) {
    const { d } = await this.derived(intent, now);
    return {
      id: String(intent._id), method: intent.method, status: d.status, amountMinor: intent.amountMinor, currency: intent.currency, currencyExponent: intent.currencyExponent,
      qrPayload: intent.qrPayload, expiresAt: intent.expiresAt, serverTime: now,
      secondsRemaining: isOpen(d.status) ? Math.max(0, Math.ceil((new Date(intent.expiresAt).getTime() - now.getTime()) / 1000)) : 0,
      confirmedAt: d.confirmedAt, paidAfterExpiry: d.paidAfterExpiry, consumed: d.consumed, saleId: d.saleId,
      refundedMinor: d.refundedMinor, refundStatus: d.refundStatus, saleAttemptKey: intent.saleAttemptKey, attention: d.attention,
      createdAt: intent.createdAt,
    };
  }

  async getIntent(storeId: string, id: string) {
    const intent = await this.getIntentOrThrow(storeId, id);
    await this.expireIfDue(intent); // lazy expiry: correct even when the poller is not running
    return this.view(intent);
  }

  /** The till reports that it is showing the QR. Idempotent. */
  async markPresented(storeId: string, id: string) {
    const intent = await this.getIntentOrThrow(storeId, id);
    const { d } = await this.derived(intent);
    if (d.status === 'created') await this.appendEvent(intent, 'presented', { source: 'cashier' });
    return this.view(intent);
  }

  async cancel(storeId: string, id: string, employeeId?: string | null) {
    const intent = await this.getIntentOrThrow(storeId, id);
    const { d } = await this.derived(intent);
    if (d.confirmed) throw new ConflictException({ code: 'PAYMENT_ALREADY_CONFIRMED', message: 'The customer has already paid; refund it instead' });
    if (isOpen(d.status)) {
      await this.appendEvent(intent, 'cancelled', { source: 'cashier', employeeId: employeeId ?? undefined });
      await this.provider(intent.providerKey).cancel(intent.providerRef).catch((e) => this.logger.warn(`provider cancel failed for ${intent._id}: ${e?.message}`));
    }
    return this.view(intent);
  }

  // ── provider outcomes (webhook + poll go through the same function) ─────────────────────────────────────────────

  /**
   * Applies one provider outcome to an intent. Idempotent: a duplicate confirmation, a duplicate webhook, a replayed poll all end in
   * "nothing new written". Rules (money is never lost, never silently ignored):
   *  • confirmed while open            → `confirmed`
   *  • confirmed after expired/cancelled/failed → `confirmed` with `late:true` (a "paid after expiry" item for a manager)
   *  • confirmed with the wrong amount → `anomaly` (NOT confirmed — a manager decides)
   *  • failed/expired after confirmed  → `anomaly` (a paid payment is never moved back)
   */
  async applyOutcome(intent: any, o: ProviderOutcome, source: 'webhook' | 'poll'): Promise<{ wrote: PaymentEventType | null }> {
    const { d, events } = await this.derived(intent);
    const base = { source, providerEventId: o.providerEventId ?? undefined, providerKey: o.providerEventId ? intent.providerKey : undefined, at: o.occurredAt };

    if (o.kind === 'confirmed') {
      if (d.confirmed) return { wrote: null };
      if (o.amountMinor !== null && o.amountMinor !== intent.amountMinor) {
        const r = await this.appendEvent(intent, 'anomaly', { ...base, amountMinor: o.amountMinor ?? undefined, note: 'amount_mismatch', meta: { expectedMinor: intent.amountMinor, receivedMinor: o.amountMinor } });
        return { wrote: r.created ? 'anomaly' : null };
      }
      const late = isTerminalUnpaid(d.status);
      const r = await this.appendEvent(intent, 'confirmed', { ...base, amountMinor: intent.amountMinor, late: late || undefined, meta: late ? { afterStatus: d.status } : undefined });
      if (r.created && late) this.logger.warn(`[payment-paid-after-expiry] intent=${intent._id} store=${intent.storeId} after=${d.status} amountMinor=${intent.amountMinor}`);
      return { wrote: r.created ? 'confirmed' : null };
    }
    if (o.kind === 'failed' || o.kind === 'expired') {
      if (d.confirmed) {
        const r = await this.appendEvent(intent, 'anomaly', { ...base, note: `${o.kind}_after_confirmed`, meta: { kind: o.kind } });
        return { wrote: r.created ? 'anomaly' : null };
      }
      if (!isOpen(d.status)) return { wrote: null };
      const r = await this.appendEvent(intent, o.kind, { ...base, note: o.reason ?? undefined });
      return { wrote: r.created ? o.kind : null };
    }
    if (o.kind === 'pending') {
      if (d.status === 'created' || d.status === 'presented') { const r = await this.appendEvent(intent, 'pending', base); return { wrote: r.created ? 'pending' : null }; }
      return { wrote: null };
    }
    if (o.kind === 'refund_succeeded' || o.kind === 'refund_failed') {
      const refundId = o.refundId ?? undefined;
      if (!refundId) return { wrote: null };
      const req = events.find((e: any) => e.type === 'refund_requested' && e.refundId === refundId);
      if (!req) { this.logger.warn(`refund outcome for unknown refund ${refundId} on ${intent._id}`); return { wrote: null }; }
      const settled = events.some((e: any) => e.refundId === refundId && (e.type === 'refund_succeeded' || e.type === 'refund_failed'));
      if (settled) return { wrote: null };
      const r = await this.appendEvent(intent, o.kind, { ...base, refundId, amountMinor: req.amountMinor, providerRefundRef: o.providerRefundRef ?? undefined, note: o.reason ?? undefined });
      return { wrote: r.created ? o.kind : null };
    }
    return { wrote: null };
  }

  /** Expire an open intent whose time has run out — after one last look at the provider, so a payment made just in time is not lost. */
  async expireIfDue(intent: any, now = new Date()): Promise<boolean> {
    const { d } = await this.derived(intent, now);
    if (!isOpen(d.status) || now.getTime() < new Date(intent.expiresAt).getTime()) return false;
    const provider = this.provider(intent.providerKey);
    try {
      const o = await provider.getStatus(intent.providerRef);
      if (o.kind === 'confirmed' || o.kind === 'failed') { await this.applyOutcome(intent, o, 'poll'); const again = await this.derived(intent, now); if (!isOpen(again.d.status)) return false; }
    } catch (e: any) { this.logger.warn(`last provider look failed for ${intent._id}: ${e?.message}`); }
    await this.appendEvent(intent, 'expired', { source: 'system' });
    await provider.cancel(intent.providerRef).catch(() => undefined);
    return true;
  }

  // ── refunds ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Provider refund as its own events: refund_requested → refund_succeeded | refund_failed (a pending refund finishes by webhook/poll). */
  async refund(storeId: string, id: string, actor: { employeeId: string }, dto: { amountMinor: number; reason: string; refundKey: string }) {
    const intent = await this.getIntentOrThrow(storeId, id);
    if (!isSafeMinor(dto.amountMinor) || dto.amountMinor <= 0) throw new BadRequestException({ code: 'INVALID_AMOUNT', message: 'amountMinor must be a positive integer' });
    if (!dto.reason || !dto.reason.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A refund reason is required' });
    if (!dto.refundKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'refundKey is required' });

    const before = await this.derived(intent);
    if (!before.d.confirmed) throw new ConflictException({ code: 'PAYMENT_NOT_CONFIRMED', message: 'Only a confirmed payment can be refunded' });
    const existing = before.events.find((e: any) => e.type === 'refund_requested' && e.refundId === dto.refundKey);
    if (existing && existing.amountMinor !== dto.amountMinor) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This refund key was used for a different amount' });

    const req = await this.appendEvent(intent, 'refund_requested', { source: 'manager', refundId: dto.refundKey, amountMinor: dto.amountMinor, employeeId: actor.employeeId, note: dto.reason.trim().slice(0, 300) });
    if (!req.created) return this.refundView(intent, dto.refundKey); // retry of the same refund: report where it stands

    // Over-refund guard that is race-free: the request is already in the log; if everything requested up to and including it exceeds the
    // paid amount, THIS request (the later one in sequence order) is the one that fails — before the provider is ever called.
    const events = await this.eventsOf(String(intent._id));
    const upToMe = events.filter((e: any) => e.seq <= req.event.seq);
    const committed = this.refundCommitted(upToMe);
    if (committed > intent.amountMinor) {
      await this.appendEvent(intent, 'refund_failed', { source: 'system', refundId: dto.refundKey, amountMinor: dto.amountMinor, note: 'exceeds_refundable_amount' });
      throw new ConflictException({ code: 'REFUND_EXCEEDS_PAID', message: 'The refund is more than what is left to refund' });
    }

    let res;
    try {
      res = await this.provider(intent.providerKey).refund({ providerRef: intent.providerRef, refundId: dto.refundKey, amountMinor: dto.amountMinor, currency: intent.currency, reason: dto.reason });
    } catch (e: any) {
      // unknown outcome (timeout…): leave the request open — the poller asks the provider again; never guess "failed" for money that may have moved
      this.logger.error(`provider refund call errored for ${intent._id}/${dto.refundKey}: ${e?.message}`);
      await this.writeAudit(intent, 'payment_refund_requested', actor.employeeId, { refundId: dto.refundKey, amountMinor: dto.amountMinor, outcome: 'unknown' });
      return this.refundView(intent, dto.refundKey);
    }
    if (res.status === 'succeeded') await this.appendEvent(intent, 'refund_succeeded', { source: 'system', refundId: dto.refundKey, amountMinor: dto.amountMinor, providerRefundRef: res.providerRefundRef ?? undefined });
    else if (res.status === 'failed') await this.appendEvent(intent, 'refund_failed', { source: 'system', refundId: dto.refundKey, amountMinor: dto.amountMinor, note: res.reason ?? 'provider_declined' });
    await this.writeAudit(intent, 'payment_refund_requested', actor.employeeId, { refundId: dto.refundKey, amountMinor: dto.amountMinor, outcome: res.status });
    return this.refundView(intent, dto.refundKey);
  }

  private refundCommitted(events: any[]): number {
    const byRefund = new Map<string, any[]>();
    for (const e of events) if (e.type.startsWith('refund_') && e.refundId) byRefund.set(e.refundId, [...(byRefund.get(e.refundId) ?? []), e]);
    let sum = 0;
    for (const l of byRefund.values()) { const last = l[l.length - 1]; if (last.type !== 'refund_failed') sum += l.find((e) => e.type === 'refund_requested')?.amountMinor ?? 0; }
    return sum;
  }

  private async refundView(intent: any, refundId: string) {
    const events = await this.eventsOf(String(intent._id));
    const mine = events.filter((e: any) => e.refundId === refundId);
    const last = mine[mine.length - 1];
    const d = derivePayment(events, intent.amountMinor, new Date());
    return { refundId, status: last?.type === 'refund_succeeded' ? 'succeeded' : last?.type === 'refund_failed' ? 'failed' : 'pending', amountMinor: mine[0]?.amountMinor ?? null, reason: last?.note ?? null, payment: await this.view(intent), refundedMinor: d.refundedMinor };
  }

  // ── reconciliation (needs attention) ───────────────────────────────────────────────────────────────────────────

  /** Everything a manager must look at: paid after expiry, confirmed but never attached to a sale, anomalies, failed refunds. */
  async listAttention(storeId: string, now = new Date()) {
    const since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const cand = await this.events.find({ storeId, at: { $gte: since }, type: { $in: ['confirmed', 'anomaly', 'refund_failed'] } }).select('intentId').limit(1000).lean();
    const ids = [...new Set(cand.map((c: any) => c.intentId))];
    if (!ids.length) return { items: [] as any[] };
    const [intents, evs] = await Promise.all([this.intents.find({ _id: { $in: ids }, storeId }).lean(), this.events.find({ intentId: { $in: ids } }).sort({ seq: 1 }).lean()]);
    const byIntent = new Map<string, any[]>();
    for (const e of evs) byIntent.set(e.intentId, [...(byIntent.get(e.intentId) ?? []), e]);
    const items: any[] = [];
    for (const it of intents as any[]) {
      const d = derivePayment((byIntent.get(String(it._id)) ?? []) as any, it.amountMinor, now, paymentsConfig().unattachedGraceMs);
      for (const reason of d.attention) {
        items.push({
          intentId: String(it._id), reason, amountMinor: it.amountMinor, currency: it.currency, currencyExponent: it.currencyExponent, saleAttemptKey: it.saleAttemptKey,
          sessionId: it.sessionId, registerId: it.registerId, employeeId: it.employeeId, confirmedAt: d.confirmedAt, refundedMinor: d.refundedMinor, createdAt: it.createdAt,
        });
      }
    }
    items.sort((a, b) => new Date(b.confirmedAt ?? b.createdAt).getTime() - new Date(a.confirmedAt ?? a.createdAt).getTime());
    return { items };
  }

  /** A manager closes an attention item: attach the payment to a sale that exists, refund it, or (anomaly on an UNPAID intent only) dismiss it. */
  async reconcile(storeId: string, id: string, actor: { employeeId: string }, dto: { resolution: 'sale_recorded' | 'refund' | 'dismissed'; saleId?: string; note?: string }) {
    const intent = await this.getIntentOrThrow(storeId, id);
    const { d } = await this.derived(intent);
    if (d.reconciled) throw new ConflictException({ code: 'ALREADY_RECONCILED', message: 'This payment was already reconciled' });
    if (d.attention.length === 0) throw new ConflictException({ code: 'NOTHING_TO_RECONCILE', message: 'This payment does not need reconciliation' });
    const note = (dto.note ?? '').trim().slice(0, 300);

    if (dto.resolution === 'sale_recorded') {
      if (!d.confirmed) throw new ConflictException({ code: 'PAYMENT_NOT_CONFIRMED', message: 'Only a confirmed payment can be attached to a sale' });
      if (!dto.saleId || !Types.ObjectId.isValid(dto.saleId)) throw new BadRequestException({ code: 'SALE_REQUIRED', message: 'saleId is required' });
      const sale: any = await this.sales.findOne({ _id: dto.saleId, storeId }).select('_id saleNumber').lean();
      if (!sale) throw new NotFoundException({ code: 'SALE_NOT_FOUND', message: 'That sale does not exist in this store' });
      await this.appendEvent(intent, 'reconciled', { source: 'manager', saleId: String(sale._id), employeeId: actor.employeeId, note: note || 'attached to sale', meta: { resolution: 'sale_recorded' } });
    } else if (dto.resolution === 'refund') {
      if (!d.confirmed) throw new ConflictException({ code: 'PAYMENT_NOT_CONFIRMED', message: 'Only a confirmed payment can be refunded' });
      const remaining = intent.amountMinor - d.refundedMinor - d.refundPendingMinor;
      if (remaining <= 0) throw new ConflictException({ code: 'NOTHING_TO_REFUND', message: 'Everything has already been refunded' });
      const r = await this.refund(storeId, id, actor, { amountMinor: remaining, reason: note || 'reconciliation refund', refundKey: `reconcile-${id}` });
      if (r.status === 'failed') throw new ConflictException({ code: 'REFUND_FAILED', message: 'The provider declined the refund; the item stays open' });
      await this.appendEvent(intent, 'reconciled', { source: 'manager', employeeId: actor.employeeId, note: note || 'refunded', meta: { resolution: 'refund', refundId: `reconcile-${id}`, refundStatus: r.status } });
    } else {
      if (d.confirmed) throw new ConflictException({ code: 'MONEY_RECEIVED', message: 'Money was received for this payment; attach it to a sale or refund it' });
      if (note.length < 10) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'Explain why this is dismissed (at least 10 characters)' });
      await this.appendEvent(intent, 'reconciled', { source: 'manager', employeeId: actor.employeeId, note, meta: { resolution: 'dismissed' } });
    }
    await this.writeAudit(intent, 'payment_reconciled', actor.employeeId, { resolution: dto.resolution, saleId: dto.saleId ?? null, reasons: d.attention });
    return this.view(intent);
  }

  async writeAudit(intent: any, action: string, employeeId: string | null | undefined, metadata: object) {
    await this.audit.create([{
      storeId: intent.storeId, employeeId: employeeId ?? null, action, targetId: String(intent._id), targetType: 'payment_intent', metadata,
      sessionId: intent.sessionId ?? null, registerId: intent.registerId ?? null, shiftId: intent.shiftId ?? null, deviceId: intent.deviceId ?? null,
    }]);
  }
}
