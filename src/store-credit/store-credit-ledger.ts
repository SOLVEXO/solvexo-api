/* eslint-disable prettier/prettier */
import type { ClientSession } from 'mongoose';
import { fromMinor, isoExponent, toMinor } from '../common/money-minor.util';

/**
 * The store-credit ledger in MINOR units (G3.3, D3) — the one implementation behind the storefront's `StoreCreditService` (when the ledger mode is `new`) and the till.
 * Spending takes units from lots with a conditional `$inc` (`remainingMinor >= take`), so a till and the storefront (or two tills) spending the same balance at the same
 * moment can never both get the last unit; a spend that cannot be covered puts back what it took. Everything is integers: no rounding, no tolerances, any currency exponent.
 */
export type CreditActor = { actorId: string | null; actorRole: string | null };
export interface CreditRefs { orderId?: string | null; checkoutId?: string | null; saleId?: string | null; refundId?: string | null; creditNoteNumber?: string | null; approvedBy?: string | null; deviceId?: string | null; registerId?: string | null; sessionId?: string | null }
type Consumed = Array<{ lotId: string; amountMinor: number }>;

export class StoreCreditLedger {
  constructor(private readonly r: { storeCreditLotModel: any; storeCreditEntryModel: any; storeModel: any }) {}
  private get lots() { return this.r.storeCreditLotModel; }
  private get entries() { return this.r.storeCreditEntryModel; }

  async currencyOf(storeId: string): Promise<{ currency: string; exp: number }> {
    const s: any = await this.r.storeModel.findById(storeId).select('baseCurrency').lean();
    const currency = String(s?.baseCurrency ?? 'USD').toUpperCase();
    return { currency, exp: isoExponent(currency) };
  }

  private lotsFilter(storeId: string, customerId: string, currency: string, now: Date) {
    return { storeId, customerId, currency, remainingMinor: { $gt: 0 }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
  }

  async balanceMinor(storeId: string, customerId: string, currency: string, now = new Date(), session?: ClientSession): Promise<number> {
    const rows: Array<{ total: any }> = await this.lots.aggregate([{ $match: this.lotsFilter(storeId, customerId, currency, now) }, { $group: { _id: null, total: { $sum: '$remainingMinor' } } }]).session(session ?? null);
    const t = rows[0]?.total;
    return t == null ? 0 : typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
  }

  /** FIFO by soonest expiry, never-expiring credit last, oldest first. All-or-nothing: a shortfall puts back what was taken. */
  async consume(storeId: string, customerId: string, currency: string, amountMinor: number, now: Date, session?: ClientSession): Promise<{ ok: boolean; consumed: Consumed; shortMinor: number }> {
    const consumed: Consumed = [];
    let need = amountMinor;
    for (let pass = 0; pass < 3 && need > 0; pass++) {
      const lots: any[] = await this.lots.find(this.lotsFilter(storeId, customerId, currency, now)).session(session ?? null).lean();
      lots.sort((a, b) => (a.expiresAt ? +new Date(a.expiresAt) : Infinity) - (b.expiresAt ? +new Date(b.expiresAt) : Infinity) || +new Date(a.createdAt) - +new Date(b.createdAt));
      if (!lots.length) break;
      for (const lot of lots) {
        if (need <= 0) break;
        const take = Math.min(Number(lot.remainingMinor), need);
        if (take <= 0) continue;
        const res = await this.lots.updateOne({ _id: lot._id, remainingMinor: { $gte: take } }, { $inc: { remainingMinor: -take } }, { session });
        if ((res as any).modifiedCount === 1) { consumed.push({ lotId: String(lot._id), amountMinor: take }); need -= take; }
      }
    }
    if (need > 0) { await this.putBack(consumed, session); return { ok: false, consumed: [], shortMinor: need }; }
    return { ok: true, consumed, shortMinor: 0 };
  }

  async putBack(consumed: Consumed, session?: ClientSession) {
    for (const c of consumed) await this.lots.updateOne({ _id: c.lotId }, { $inc: { remainingMinor: c.amountMinor } }, { session });
  }

  private async writeEntry(d: any, session?: ClientSession) {
    const [doc] = await this.entries.create([d], session ? { session } : undefined);
    return doc;
  }

  /** Creates a lot of credit + its entry. Returns null when [idemKey] was already applied (idempotent). */
  async addLot(a: { storeId: string; customerId: string; amountMinor: number; type: 'issue' | 'adjust_credit' | 'restore' | 'refund_credit' | 'opening_balance' | 'spend_reversal'; expiresAt?: Date | null; idemKey?: string | null; note?: string; actor: CreditActor; refs?: CreditRefs; legacyId?: string | null; createdAt?: Date }, session?: ClientSession) {
    if (!(a.amountMinor > 0)) return null;
    const { currency, exp } = await this.currencyOf(a.storeId);
    if (a.idemKey && (await this.entries.exists({ storeId: a.storeId, type: a.type, idemKey: a.idemKey }).session(session ?? null))) return null;
    const before = await this.balanceMinor(a.storeId, a.customerId, currency, new Date(), session);
    const [lot] = await this.lots.create([{ storeId: a.storeId, customerId: a.customerId, currency, currencyExponent: exp, amountMinor: a.amountMinor, remainingMinor: a.amountMinor, expiresAt: a.expiresAt ?? null, source: a.type, legacyId: a.legacyId ?? null, ...(a.createdAt ? { createdAt: a.createdAt } : {}) }], session ? { session } : undefined);
    try {
      const entry = await this.writeEntry({ storeId: a.storeId, customerId: a.customerId, currency, currencyExponent: exp, type: a.type, amountMinor: a.amountMinor, balanceAfterMinor: before + a.amountMinor, lotId: String(lot._id), expiresAt: a.expiresAt ?? null, idemKey: a.idemKey ?? null, note: a.note ?? '', actorId: a.actor.actorId, actorRole: a.actor.actorRole, legacyId: a.legacyId ?? null, ...(a.refs ?? {}), ...(a.createdAt ? { createdAt: a.createdAt } : {}) }, session);
      await this.lots.updateOne({ _id: lot._id }, { $set: { entryId: String(entry._id) } }, { session });
      return { lot, entry };
    } catch (e: any) {
      if (e?.code === 11000 && !session) { await this.lots.deleteOne({ _id: lot._id }); return null; } // lost a race with a duplicate call
      throw e;
    }
  }

  /** Spends [amountMinor]: `redeem` (storefront order) or `spend` (till sale). Idempotent per [idemKey]. ok=false → the balance does not cover it (nothing is taken). */
  async spend(a: { storeId: string; customerId: string; amountMinor: number; type: 'redeem' | 'spend' | 'adjust_debit' ; idemKey?: string | null; note?: string; actor: CreditActor; refs?: CreditRefs }, session?: ClientSession): Promise<{ ok: boolean; duplicate?: boolean; entry?: any; shortMinor?: number }> {
    if (!(a.amountMinor > 0)) return { ok: true, duplicate: true };
    const { currency } = await this.currencyOf(a.storeId);
    if (a.idemKey && (await this.entries.exists({ storeId: a.storeId, type: a.type, idemKey: a.idemKey }).session(session ?? null))) return { ok: true, duplicate: true };
    const now = new Date();
    let res = await this.consume(a.storeId, a.customerId, currency, a.amountMinor, now, session);
    // Two spenders racing for the SAME balance can each grab part of it and both back off (safe, but nobody wins): while the balance still covers the amount, try again
    // after a short jittered pause so exactly one of them completes. A concurrent duplicate of the SAME event (same idemKey) is simply that event, done.
    for (let attempt = 0; attempt < 6 && !res.ok && !session; attempt++) {
      if (a.idemKey && (await this.entries.exists({ storeId: a.storeId, type: a.type, idemKey: a.idemKey }))) return { ok: true, duplicate: true };
      if ((await this.balanceMinor(a.storeId, a.customerId, currency, now)) < a.amountMinor) break;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 25));
      res = await this.consume(a.storeId, a.customerId, currency, a.amountMinor, now);
    }
    if (!res.ok) {
      if (a.idemKey && (await this.entries.exists({ storeId: a.storeId, type: a.type, idemKey: a.idemKey }).session(session ?? null))) return { ok: true, duplicate: true };
      return { ok: false, shortMinor: res.shortMinor };
    }
    const { exp } = await this.currencyOf(a.storeId);
    const after = await this.balanceMinor(a.storeId, a.customerId, currency, now, session);
    try {
      const entry = await this.writeEntry({ storeId: a.storeId, customerId: a.customerId, currency, currencyExponent: exp, type: a.type, amountMinor: -a.amountMinor, balanceAfterMinor: after, consumed: res.consumed, idemKey: a.idemKey ?? null, note: a.note ?? '', actorId: a.actor.actorId, actorRole: a.actor.actorRole, ...(a.refs ?? {}) }, session);
      return { ok: true, entry };
    } catch (e: any) {
      if (e?.code === 11000 && !session) { await this.putBack(res.consumed); return { ok: true, duplicate: true }; }
      throw e;
    }
  }

  /** Daily sweep: lots past their expiry are zeroed, an `expire` entry records each. */
  async expireDue(now = new Date()): Promise<{ expired: number }> {
    const due: any[] = await this.lots.find({ expiresAt: { $ne: null, $lte: now }, remainingMinor: { $gt: 0 }, expiredHandled: false }).limit(500).lean();
    let expired = 0;
    for (const lot of due) {
      const claimed: any = await this.lots.findOneAndUpdate({ _id: lot._id, expiredHandled: false, remainingMinor: { $gt: 0 } }, { $set: { expiredHandled: true, remainingMinor: 0 } }, { new: false });
      if (!claimed) continue;
      const lost = Number(claimed.remainingMinor);
      if (!(lost > 0)) continue;
      const after = await this.balanceMinor(lot.storeId, lot.customerId, lot.currency, now);
      await this.writeEntry({ storeId: lot.storeId, customerId: lot.customerId, currency: lot.currency, currencyExponent: lot.currencyExponent, type: 'expire', amountMinor: -lost, balanceAfterMinor: after, consumed: [{ lotId: String(lot._id), amountMinor: lost }], note: 'Store credit expired', actorId: null, actorRole: 'system' });
      expired++;
    }
    return { expired };
  }

  /** Legacy-shaped (major units) view of an entry — what the storefront / dashboard responses always looked like. */
  async legacyRow(e: any, lotsById: Map<string, any>) {
    const exp = e.currencyExponent;
    const lot = e.lotId ? lotsById.get(String(e.lotId)) : null;
    return {
      _id: e._id, storeId: e.storeId, customerId: e.customerId, currency: e.currency, type: e.type === 'spend' ? 'redeem' : e.type === 'spend_reversal' ? 'restore' : e.type === 'opening_balance' ? 'issue' : e.type,
      amount: fromMinor(Number(e.amountMinor), exp), balanceAfter: fromMinor(Number(e.balanceAfterMinor), exp),
      remaining: lot ? fromMinor(Number(lot.remainingMinor), exp) : 0, expiresAt: e.expiresAt ?? null, expiredHandled: !!lot?.expiredHandled,
      consumed: (e.consumed ?? []).map((c: any) => ({ lotId: c.lotId, amount: fromMinor(Number(c.amountMinor), exp) })),
      orderId: e.orderId ?? null, checkoutId: e.checkoutId ?? null, idemKey: e.idemKey ?? null, note: e.note ?? '', actorId: e.actorId ?? null, actorRole: e.actorRole ?? null, createdAt: e.createdAt, updatedAt: e.createdAt,
    };
  }

  async overview(storeId: string, customerId: string, query: any = {}) {
    const { currency, exp } = await this.currencyOf(storeId);
    const now = new Date();
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const [balanceMinor, rows, total, expiring] = await Promise.all([
      this.balanceMinor(storeId, customerId, currency, now),
      this.entries.find({ storeId, customerId }).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.entries.countDocuments({ storeId, customerId }),
      this.lots.find({ ...this.lotsFilter(storeId, customerId, currency, now), expiresAt: { $ne: null, $gt: now } }).sort({ expiresAt: 1 }).limit(1).lean(),
    ]);
    const lotIds = (rows as any[]).map((e) => e.lotId).filter(Boolean);
    const lotRows: any[] = lotIds.length ? await this.lots.find({ _id: { $in: lotIds } }).lean() : [];
    const byId = new Map(lotRows.map((l) => [String(l._id), l]));
    const items = await Promise.all((rows as any[]).map((e) => this.legacyRow(e, byId)));
    const next: any = (expiring as any[])[0];
    return { success: true, data: { currency, balance: fromMinor(balanceMinor, exp), nextExpiry: next ? { expiresAt: next.expiresAt, amount: fromMinor(Number(next.remainingMinor), exp) } : null, transactions: { items, total, page, limit } } };
  }
}
export { toMinor, fromMinor };
