/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { round } from '../common/number.util';

type Actor = { actorId: string | null; actorRole: 'seller' | 'staff' | 'admin' | 'user' | 'system' };

/**
 * Shopify-style STORE CREDIT.
 *
 *  - A merchant can issue credit to a customer, add to it, or remove it (with a note and an optional
 *    expiry date on the credit being issued).
 *  - The customer's balance is spent automatically at checkout (see CheckoutService.applyStoreCredit);
 *    unspent credit past its expiry date is swept by a daily job.
 *  - A refund can be issued AS store credit instead of back to the original payment method.
 *  - Credit used on an order comes back if that order is cancelled or returned.
 *
 * Credit lives in the STORE'S own currency and is scoped to one store + one customer. There is no
 * balance document: a balance is the sum of the `remaining` of a customer's non-expired credit lots
 * (see StoreCreditTransaction), so it can never drift from the ledger.
 */
@Injectable()
export class StoreCreditService {
  private readonly logger = new Logger(StoreCreditService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get txModel() { return this.db.repositories.storeCreditTransactionModel; }

  private lotsFilter(storeId: string, customerId: string, currency: string, now: Date) {
    return {
      storeId, customerId, currency, remaining: { $gt: 0 },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    };
  }

  // ── balance ──────────────────────────────────────────────────────────────

  async getStoreCurrency(storeId: string): Promise<string> {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('baseCurrency').lean();
    return store?.baseCurrency ?? 'USD';
  }

  /** What the customer can spend right now (non-expired credit), in the store's currency. */
  async getSpendableBalance(storeId: string, customerId: string, currency?: string, now = new Date()): Promise<number> {
    const cur = currency ?? (await this.getStoreCurrency(storeId));
    const rows: Array<{ total: number }> = await this.txModel.aggregate([
      { $match: this.lotsFilter(storeId, customerId, cur, now) },
      { $group: { _id: null, total: { $sum: '$remaining' } } },
    ]);
    return round(rows[0]?.total ?? 0);
  }

  /** Throws unless the customer still has at least `amount` spendable — used right before taking payment. */
  async assertCovers(storeId: string, customerId: string, amount: number): Promise<void> {
    if (!(amount > 0)) return;
    const balance = await this.getSpendableBalance(storeId, customerId);
    if (balance + 0.005 < amount) {
      throw new BadRequestException('Your store credit balance changed and no longer covers this order. Please review your checkout and apply store credit again.');
    }
  }

  // ── drawing credit down (FIFO by soonest expiry; never-expiring credit last) ──

  private async consume(storeId: string, customerId: string, currency: string, amount: number, now: Date) {
    const consumed: Array<{ lotId: string; amount: number }> = [];
    let need = round(amount);

    const lots: any[] = await this.txModel.find(this.lotsFilter(storeId, customerId, currency, now)).lean();
    lots.sort((a, b) => {
      const ea = a.expiresAt ? +new Date(a.expiresAt) : Infinity;
      const eb = b.expiresAt ? +new Date(b.expiresAt) : Infinity;
      return ea - eb || +new Date(a.createdAt) - +new Date(b.createdAt);
    });

    for (const lot of lots) {
      if (need <= 0.0049) break;
      const take = round(Math.min(lot.remaining, need));
      if (take <= 0) continue;
      // Conditional decrement — a concurrent spend of the same lot loses cleanly instead of overdrawing.
      const res = await this.txModel.updateOne({ _id: lot._id, remaining: { $gte: take } }, { $inc: { remaining: -take } });
      if ((res as any).modifiedCount === 1) {
        consumed.push({ lotId: String(lot._id), amount: take });
        need = round(need - take);
      }
    }

    if (need > 0.0049) {
      await this.putBack(consumed); // couldn't cover it — undo what was drawn
      return { ok: false as const, consumed: [] as typeof consumed, shortBy: need };
    }
    return { ok: true as const, consumed, shortBy: 0 };
  }

  private async putBack(consumed: Array<{ lotId: string; amount: number }>) {
    for (const c of consumed) {
      await this.txModel.updateOne({ _id: c.lotId }, { $inc: { remaining: c.amount } });
    }
  }

  // ── merchant actions ─────────────────────────────────────────────────────

  /** Issue (positive) or remove (negative) credit — Shopify's "Issue store credit" / "Credit or debit". */
  async adjust(
    storeId: string, customerId: string,
    input: { amount: number; note?: string; expiresAt?: string | Date | null },
    actor: Actor,
  ) {
    const amount = round(Number(input.amount));
    if (!amount || !Number.isFinite(amount)) throw new BadRequestException('A non-zero amount is required');
    const currency = await this.getStoreCurrency(storeId);
    const now = new Date();
    const note = (input.note ?? '').trim().slice(0, 300);

    if (amount > 0) {
      let expiresAt: Date | null = null;
      if (input.expiresAt) {
        expiresAt = new Date(input.expiresAt);
        if (isNaN(expiresAt.getTime()) || expiresAt <= now) throw new BadRequestException('The expiry date must be in the future');
      }
      const before = await this.getSpendableBalance(storeId, customerId, currency, now);
      const hadAny = await this.txModel.exists({ storeId, customerId, currency });
      const tx = await this.txModel.create({
        storeId, customerId, currency, type: hadAny ? 'adjust_credit' : 'issue',
        amount, remaining: amount, expiresAt, balanceAfter: round(before + amount),
        note, actorId: actor.actorId, actorRole: actor.actorRole,
      });
      await this.afterAdjust(storeId, customerId, currency, amount, actor, note, expiresAt);
      return { success: true, message: 'Store credit added', data: { balance: round(before + amount), currency, transaction: tx } };
    }

    // removing credit
    const take = round(-amount);
    const spendable = await this.getSpendableBalance(storeId, customerId, currency, now);
    if (take > spendable + 0.005) {
      throw new BadRequestException(`You can remove at most ${spendable.toFixed(2)} ${currency} — that's this customer's current balance.`);
    }
    const res = await this.consume(storeId, customerId, currency, take, now);
    if (!res.ok) throw new BadRequestException('The balance changed while you were editing it — please try again.');
    const tx = await this.txModel.create({
      storeId, customerId, currency, type: 'adjust_debit', amount: -take, consumed: res.consumed,
      balanceAfter: round(spendable - take), note, actorId: actor.actorId, actorRole: actor.actorRole,
    });
    await this.afterAdjust(storeId, customerId, currency, -take, actor, note, null);
    return { success: true, message: 'Store credit removed', data: { balance: round(spendable - take), currency, transaction: tx } };
  }

  private async afterAdjust(storeId: string, customerId: string, currency: string, amount: number, actor: Actor, note: string, expiresAt: Date | null) {
    this.activityLogService.log({
      storeId, category: 'customers', action: amount > 0 ? 'store_credit_added' : 'store_credit_removed',
      description: `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount).toFixed(2)} ${currency} store credit${note ? ` — ${note}` : ''}`,
      actorId: actor.actorId ?? undefined, actorRole: actor.actorRole, targetId: customerId, targetType: 'customer',
    });
    if (amount > 0) {
      this.notificationsService.notify({
        recipientId: customerId, recipientRole: 'user', type: NOTIFICATION_TYPES.STORE_CREDIT_RECEIVED,
        title: 'You received store credit',
        body: `You've been given ${amount.toFixed(2)} ${currency} in store credit${expiresAt ? ` (expires ${expiresAt.toISOString().slice(0, 10)})` : ''}. It will be applied at checkout.`,
        data: { storeId },
      }).catch(() => undefined);
    }
  }

  /** Seller-facing: a customer's balance + ledger. The customer must belong to the store. */
  async getCustomerOverview(storeId: string, customerId: string, query: any = {}) {
    await this.assertCustomerOfStore(storeId, customerId);
    return this.overview(storeId, customerId, query);
  }

  /** Buyer-facing: my balance + history in this store. */
  async getMyOverview(storeId: string, customerId: string, query: any = {}) {
    return this.overview(storeId, customerId, query);
  }

  private async overview(storeId: string, customerId: string, query: any) {
    const currency = await this.getStoreCurrency(storeId);
    const now = new Date();
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const [balance, items, total, expiring] = await Promise.all([
      this.getSpendableBalance(storeId, customerId, currency, now),
      this.txModel.find({ storeId, customerId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.txModel.countDocuments({ storeId, customerId }),
      this.txModel.find({ ...this.lotsFilter(storeId, customerId, currency, now), expiresAt: { $ne: null, $gt: now } }).sort({ expiresAt: 1 }).limit(1).lean(),
    ]);
    const next: any = (expiring as any[])[0];
    return {
      success: true,
      data: {
        currency, balance,
        nextExpiry: next ? { expiresAt: next.expiresAt, amount: round(next.remaining) } : null,
        transactions: { items, total, page, limit },
      },
    };
  }

  private async assertCustomerOfStore(storeId: string, customerId: string) {
    const r = this.db.repositories;
    const user: any = await r.userModel.findById(customerId).select('storeId').lean();
    if (!user) throw new NotFoundException('Customer not found');
    if (user.storeId === storeId) return;
    const ordered = await r.orderModel.exists({ userId: customerId, 'sellerOrders.storeId': storeId, isDelete: false });
    if (!ordered) throw new ForbiddenException('This customer does not belong to your store');
  }

  // ── checkout / order lifecycle ───────────────────────────────────────────

  /** Spends credit for a placed order. Idempotent per checkout. Returns false (and logs) if the balance no longer covers it. */
  async redeemAtOrderPlacement(storeId: string, customerId: string, amount: number, checkoutId: string, orderId: string): Promise<boolean> {
    const spend = round(amount);
    if (!(spend > 0)) return true;
    const idemKey = `redeem:${checkoutId}`;
    if (await this.txModel.exists({ storeId, type: 'redeem', idemKey })) return true; // already applied for this checkout

    const currency = await this.getStoreCurrency(storeId);
    const now = new Date();
    const res = await this.consume(storeId, customerId, currency, spend, now);
    if (!res.ok) {
      this.activityLogService.log({
        storeId, category: 'customers', action: 'store_credit_redeem_failed',
        description: `Order ${orderId}: ${spend.toFixed(2)} ${currency} store credit could not be taken (balance changed after checkout) — needs review`,
        actorRole: 'system', targetId: customerId, targetType: 'customer', isSecurityAlert: true,
      });
      return false;
    }
    const after = await this.getSpendableBalance(storeId, customerId, currency, now);
    try {
      await this.txModel.create({
        storeId, customerId, currency, type: 'redeem', amount: -spend, consumed: res.consumed,
        balanceAfter: after, orderId, checkoutId, idemKey, note: 'Applied at checkout', actorId: customerId, actorRole: 'user',
      });
    } catch (err: any) {
      if (err?.code === 11000) { await this.putBack(res.consumed); return true; } // lost a race with a duplicate call
      throw err;
    }
    return true;
  }

  /** Credit used on an order comes back (cancel / return). Idempotent per refund event. */
  async restoreOnRefund(storeId: string, customerId: string, amount: number, orderId: string, idemKey: string, note = 'Restored from refund') {
    return this.addLot(storeId, customerId, amount, 'restore', orderId, idemKey, note, { actorId: null, actorRole: 'system' });
  }

  /** An order refund issued AS store credit (Shopify: "Refund to store credit"). Idempotent per refund event. */
  async creditFromRefund(storeId: string, customerId: string, amount: number, orderId: string, idemKey: string, note: string, actor: Actor) {
    const ok = await this.addLot(storeId, customerId, amount, 'refund_credit', orderId, idemKey, note, actor);
    if (ok) {
      const currency = await this.getStoreCurrency(storeId);
      this.notificationsService.notify({
        recipientId: customerId, recipientRole: 'user', type: NOTIFICATION_TYPES.STORE_CREDIT_RECEIVED,
        title: 'Refunded to store credit',
        body: `${round(amount).toFixed(2)} ${currency} was refunded to your store credit. It will be applied at checkout.`,
        data: { storeId, orderId },
      }).catch(() => undefined);
    }
    return ok;
  }

  private async addLot(
    storeId: string, customerId: string, amount: number,
    type: 'restore' | 'refund_credit', orderId: string, idemKey: string, note: string, actor: Actor,
  ): Promise<boolean> {
    const credit = round(amount);
    if (!(credit > 0)) return false;
    if (await this.txModel.exists({ storeId, type, idemKey })) return false; // this refund event was already applied
    const currency = await this.getStoreCurrency(storeId);
    const before = await this.getSpendableBalance(storeId, customerId, currency);
    try {
      await this.txModel.create({
        storeId, customerId, currency, type, amount: credit, remaining: credit, expiresAt: null,
        balanceAfter: round(before + credit), orderId, idemKey, note, actorId: actor.actorId, actorRole: actor.actorRole,
      });
    } catch (err: any) {
      if (err?.code === 11000) return false;
      throw err;
    }
    return true;
  }

  // ── expiry ───────────────────────────────────────────────────────────────

  /** Daily sweep: credit lots past their expiry date are zeroed and a ledger row records it. */
  async expireDueLots(now = new Date()) {
    const due: any[] = await this.txModel
      .find({ expiresAt: { $ne: null, $lte: now }, remaining: { $gt: 0 }, expiredHandled: false })
      .limit(500).lean();
    let expired = 0;
    for (const lot of due) {
      // Claim the lot atomically so two instances can't both expire it.
      const claimed = await this.txModel.findOneAndUpdate(
        { _id: lot._id, expiredHandled: false, remaining: { $gt: 0 } },
        { $set: { expiredHandled: true, remaining: 0 } },
        { new: false },
      );
      if (!claimed) continue;
      const lost = round((claimed as any).remaining);
      if (!(lost > 0)) continue;
      const after = await this.getSpendableBalance(lot.storeId, lot.customerId, lot.currency, now);
      await this.txModel.create({
        storeId: lot.storeId, customerId: lot.customerId, currency: lot.currency, type: 'expire',
        amount: -lost, balanceAfter: after, consumed: [{ lotId: String(lot._id), amount: lost }],
        note: 'Store credit expired', actorId: null, actorRole: 'system',
      });
      expired++;
    }
    return { expired };
  }
}
