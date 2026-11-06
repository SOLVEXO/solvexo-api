/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { CodProtectionSettings, CodProtectionSettingsDocument } from './cod-protection.schema';
import { CodConfirmationService } from './cod-confirmation.service';
import { cleanCodSettings, CodEvaluation, CodHistory, CodSettings, DEFAULT_COD_SETTINGS, evaluateCodOrder, normalizePhone } from './cod-risk.util';

const isOid = (v: any) => typeof v === 'string' && Types.ObjectId.isValid(v);
const SETTINGS_KEYS = Object.keys(DEFAULT_COD_SETTINGS) as (keyof CodSettings)[];
const RETURNED = ['received', 'refunded', 'exchanged'];
const DELIVERED = ['delivered', 'completed'];

/** What an order remembers about its COD risk check. Merchant-only: stripped from every buyer-facing order view. */
export interface OrderCodProtection {
  score: number;
  level: 'low' | 'medium' | 'high';
  decision: 'allow' | 'confirm';
  reasons: { code: string; label: string; points: number }[];
  phoneKey: string | null;
  evaluatedAt: Date;
  confirmation: null | {
    status: 'awaiting' | 'confirmed' | 'cancelled' | 'expired';
    expiresAt: Date;
    sentAt: Date | null;
    channels: string[];
    resolvedAt: Date | null;
    resolvedBy: 'customer' | 'seller' | 'system' | null;
  };
  override: null | { by: string; at: Date; note: string | null };
}

/** Cash-on-delivery protection: the store's own rules, the store's own history with a customer, and the confirmation state on orders. */
@Injectable()
export class CodProtectionService {
  constructor(
    @InjectModel(CodProtectionSettings.name) private readonly settingsModel: Model<CodProtectionSettingsDocument>,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly exchange: ExchangeRateService,
    // Sends the confirmation request once an order is stamped as waiting for the customer.
    @Optional() private readonly confirmation?: CodConfirmationService,
  ) {}

  private get orders() { return this.db.repositories.orderModel as any; }

  async getSettings(storeId: string): Promise<CodSettings> {
    const doc: any = await this.settingsModel.findOne({ storeId }).lean();
    if (!doc) return { ...DEFAULT_COD_SETTINGS };
    const out: any = { ...DEFAULT_COD_SETTINGS };
    for (const k of SETTINGS_KEYS) if (doc[k] !== undefined) out[k] = doc[k];
    return out;
  }

  async updateSettings(storeId: string, actor: { id: string; role: string }, body: any): Promise<CodSettings> {
    const current = await this.getSettings(storeId);
    const r = cleanCodSettings(body ?? {}, current);
    if (!r.ok) throw new BadRequestException(r.error);
    await this.settingsModel.updateOne({ storeId }, { $set: r.value, $setOnInsert: { storeId } }, { upsert: true });
    await this.activity.log({ storeId, category: 'orders', action: 'cod_protection_updated', description: `COD protection settings updated (${r.value.enabled ? 'on' : 'off'})`, actorId: actor.id, actorRole: actor.role, targetId: storeId, targetType: 'store' } as any).catch(() => undefined);
    return r.value;
  }

  /** The customer's history WITH THIS STORE only (by account, or by the same normalised phone on earlier COD checks). */
  async history(storeId: string, userId: string | null, phoneKey: string | null): Promise<CodHistory> {
    const or: any[] = [];
    if (userId) or.push({ userId: String(userId) });
    if (phoneKey) or.push({ 'codProtection.phoneKey': phoneKey });
    if (or.length === 0) return { delivered: 0, cancelled: 0, returned: 0, rto: 0 };
    const rows: any[] = await this.orders.find({ isDelete: false, 'sellerOrders.storeId': storeId, $or: or })
      .select('orderStatus paymentType sellerOrders.items.returnStatus sellerOrders.status').sort({ createdAt: -1 }).limit(200).lean();
    const ids = rows.map((r) => String(r._id));
    const rtoOrders: any[] = ids.length
      ? await (this.db.repositories as any).courierBookingModel.find({ storeId, orderId: { $in: ids }, rto: true }).select('orderId').lean()
      : [];
    const rtoIds = new Set(rtoOrders.map((b) => String(b.orderId)));
    const h: CodHistory = { delivered: 0, cancelled: 0, returned: 0, rto: 0 };
    for (const o of rows) {
      const returned = (o.sellerOrders ?? []).some((so: any) => (so.items ?? []).some((i: any) => RETURNED.includes(i.returnStatus)));
      if (rtoIds.has(String(o._id))) h.rto++;
      else if (o.orderStatus === 'cancelled' && o.paymentType === 'cash_on_delivery') h.cancelled++;
      else if (returned) h.returned++;
      else if (DELIVERED.includes(o.orderStatus) || (o.sellerOrders ?? []).some((so: any) => DELIVERED.includes(so.status))) h.delivered++;
    }
    return h;
  }

  /**
   * The COD verdict for a checkout, per store (the strictest store wins for a multi-store cart). `amountOverride` lets a caller pass the
   * total it is about to charge. Returns null when no store has protection switched on.
   */
  async evaluateCheckout(checkout: any, userId: string): Promise<{ evaluation: CodEvaluation; settings: CodSettings; storeId: string } | null> {
    const storeIds = [...new Set(((checkout?.items ?? []) as any[]).map((i) => String(i.storeId)))];
    let worst: { evaluation: CodEvaluation; settings: CodSettings; storeId: string } | null = null;
    const rank = { allow: 0, confirm: 1, block_cod: 2 } as const;
    const address: any = checkout?.addressId ? await (this.db.repositories as any).addressModel.findOne({ _id: checkout.addressId }).select('phoneNumber city addressLine1 addressLine2').lean() : null;
    for (const storeId of storeIds) {
      const settings = await this.getSettings(storeId);
      if (!settings.enabled) continue;
      const store: any = await this.db.repositories.storeModel.findById(storeId).select('baseCurrency').lean();
      const storeCurrency = store?.baseCurrency ?? checkout.currency;
      const amount = checkout.currency === storeCurrency ? checkout.totalAmount : this.exchange.convertWithSnapshots(checkout.totalAmount, checkout.currency, storeCurrency, checkout.fxSnapshots ?? []);
      const phoneKey = normalizePhone(address?.phoneNumber);
      const history = await this.history(storeId, userId, phoneKey);
      const evaluation = evaluateCodOrder(settings, { amount, city: address?.city, phone: address?.phoneNumber, address: `${address?.addressLine1 ?? ''} ${address?.addressLine2 ?? ''}`, history });
      if (!worst || rank[evaluation.decision] > rank[worst.evaluation.decision] || (evaluation.decision === worst.evaluation.decision && evaluation.score > worst.evaluation.score)) worst = { evaluation, settings, storeId };
    }
    return worst;
  }

  /** Refuses COD when the store's rules say so (called before a COD or split order is placed). */
  async assertCodAllowed(checkout: any, userId: string) {
    const r = await this.evaluateCheckout(checkout, userId);
    if (r?.evaluation.decision === 'block_cod') {
      throw new BadRequestException({ message: 'Cash on delivery is not available for this order. Please pay online or by bank transfer.', code: 'COD_NOT_AVAILABLE' });
    }
    return r;
  }

  /** Records the verdict on the orders just created for a COD checkout and starts the confirmation clock when one is needed. */
  async stampOrders(checkout: any, orders: any[], userId: string, now = new Date()) {
    const r = await this.evaluateCheckout(checkout, userId);
    if (!r || !Array.isArray(orders)) return;
    const { evaluation, settings } = r;
    if (evaluation.decision === 'block_cod') return; // only reachable through a path that could not refuse (e.g. a webhook): kept unstamped, the seller sees a normal order
    for (const o of orders) {
      if (!o || o.codProtection || (o.paymentType && o.paymentType !== 'cash_on_delivery')) continue;
      const stamp: OrderCodProtection = {
        score: evaluation.score, level: evaluation.level, decision: evaluation.decision, reasons: evaluation.reasons, phoneKey: evaluation.phoneKey, evaluatedAt: now,
        confirmation: evaluation.decision === 'confirm'
          ? { status: 'awaiting', expiresAt: new Date(now.getTime() + settings.confirmationHours * 3_600_000), sentAt: null, channels: [], resolvedAt: null, resolvedBy: null }
          : null,
        override: null,
      };
      await this.orders.updateOne({ _id: o._id }, { $set: { codProtection: stamp } });
      o.codProtection = stamp;
      // A failed message never fails the order: the seller sees it as waiting and can resend or confirm by hand.
      if (stamp.confirmation && this.confirmation) await this.confirmation.send(String(o._id)).catch((e: any) => console.error('COD confirmation send failed (order placed):', e?.message));
    }
  }

  /**
   * Numbers for the dashboard card. Confirmation rate = confirmed / (confirmed + cancelled + expired) among COD orders that asked for
   * confirmation; RTO rate = COD orders with a courier booking that came back / COD orders with a courier booking; saved amount = value
   * of orders the customer cancelled or never confirmed (store currency), i.e. parcels that were never shipped.
   */
  async stats(storeId: string, days = 30) {
    const d = Math.min(Math.max(Math.round(days) || 30, 1), 365);
    const since = new Date(Date.now() - d * 86_400_000);
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = store?.baseCurrency ?? 'USD';
    const rows: any[] = await this.orders.find({ isDelete: false, 'sellerOrders.storeId': storeId, paymentType: 'cash_on_delivery', createdAt: { $gte: since } })
      .select('totalAmount currency fxSnapshots codProtection.confirmation.status').limit(5000).lean();
    let asked = 0; let confirmed = 0; let cancelled = 0; let expired = 0; let awaiting = 0; let saved = 0;
    for (const o of rows) {
      const st = o.codProtection?.confirmation?.status;
      if (!st) continue;
      asked++;
      if (st === 'confirmed') confirmed++;
      else if (st === 'awaiting') awaiting++;
      else {
        if (st === 'cancelled') cancelled++; else expired++;
        saved += o.currency === currency ? o.totalAmount : this.exchange.convertWithSnapshots(o.totalAmount, o.currency, currency, o.fxSnapshots ?? []);
      }
    }
    const ids = rows.map((r) => String(r._id));
    const bookings: any[] = ids.length ? await (this.db.repositories as any).courierBookingModel.find({ storeId, orderId: { $in: ids } }).select('orderId rto').lean() : [];
    const booked = new Set(bookings.map((b) => String(b.orderId)));
    const rto = new Set(bookings.filter((b) => b.rto).map((b) => String(b.orderId)));
    const resolved = confirmed + cancelled + expired;
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      days: d, currency, codOrders: rows.length, asked, confirmed, cancelled, expired, awaiting,
      confirmationRate: resolved > 0 ? round(confirmed / resolved) : null,
      bookedOrders: booked.size, rtoOrders: rto.size, rtoRate: booked.size > 0 ? round(rto.size / booked.size) : null,
      savedAmount: round(saved),
    };
  }

  /** 404 unless this order belongs to the store (used before acting on an order id from the URL). */
  async assertOrderOfStore(storeId: string, orderId: string) {
    if (!isOid(orderId) || !(await this.orders.exists({ _id: orderId, isDelete: false, 'sellerOrders.storeId': storeId }))) throw new NotFoundException('Order not found');
  }

  /** The seller reached the customer another way (phone call): confirm the order by hand. Audited. */
  async manualConfirm(storeId: string, actor: { id: string; role: string }, orderId: string, note?: string) {
    if (!isOid(orderId)) throw new NotFoundException('Order not found');
    const now = new Date();
    const res = await this.orders.findOneAndUpdate(
      { _id: orderId, isDelete: false, 'sellerOrders.storeId': storeId, 'codProtection.confirmation.status': 'awaiting' },
      { $set: { 'codProtection.confirmation.status': 'confirmed', 'codProtection.confirmation.resolvedAt': now, 'codProtection.confirmation.resolvedBy': 'seller', 'codProtection.override': { by: actor.id, at: now, note: (note ?? '').trim().slice(0, 300) || null } } },
      { new: true },
    ).select('orderNumber').lean();
    if (!res) throw new ConflictException('This order is not waiting for confirmation.');
    await this.activity.log({ storeId, category: 'orders', action: 'cod_manually_confirmed', description: `COD order #${res.orderNumber} confirmed by hand${note ? `: ${note}` : ''}`, actorId: actor.id, actorRole: actor.role, targetId: orderId, targetType: 'order' } as any).catch(() => undefined);
    return { success: true };
  }
}

/** Throws while a COD order still waits for the customer (processing / shipping must not start before the confirmation). */
export function assertCodConfirmedForFulfilment(order: { codProtection?: { confirmation?: { status?: string } | null } | null }) {
  if (order?.codProtection?.confirmation?.status === 'awaiting') {
    throw new BadRequestException('This cash-on-delivery order is waiting for the customer to confirm it. Confirm it manually if you reached them, or cancel it.');
  }
}
