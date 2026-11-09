/* eslint-disable prettier/prettier */
import { ConflictException, Injectable, Optional } from '@nestjs/common';
import type { ClientSession } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { tierFor } from './pos-loyalty.util';

export interface ResolvedCustomer { id: string; ledgerId: string; name: string; kind: 'pos' | 'user' }

/**
 * The part of "customers" the SALE path needs (no HTTP, no permission checks, no dependency on PosService, so PosService can use it): who a customer is for credit / loyalty purposes,
 * their balances, and the loyalty writes that happen INSIDE the sale / refund transaction. The till-facing directory is `PosCustomersService`.
 */
@Injectable()
export class PosCustomerCore {
  constructor(private readonly db: DatabaseService, @Optional() private readonly credit?: StoreCreditService) {}
  get creditService() { return this.credit; }
  private get r() { return this.db.repositories; }

  // ── who is this customer? ────────────────────────────────────────────────────────────────────────────────────────
  /** A till customer id or a storefront buyer id of THIS store → the id credit / loyalty are keyed by. */
  async resolve(storeId: string, id: string | null | undefined): Promise<ResolvedCustomer | null> {
    if (!id) return null;
    const sid = String(id);
    if (/^[0-9a-fA-F]{24}$/.test(sid)) {
      const pc: any = await this.r.posCustomerModel.findOne({ _id: sid, storeId, isDelete: false }).lean();
      if (pc) return { id: String(pc._id), ledgerId: pc.userId ?? String(pc._id), name: pc.name, kind: 'pos' };
      const user: any = await this.r.userModel.findById(sid).select('name firstName lastName storeId').lean();
      if (user) {
        const belongs = user.storeId === storeId || !!(await this.r.orderModel.exists({ userId: sid, 'sellerOrders.storeId': storeId, isDelete: false }));
        if (belongs) return { id: sid, ledgerId: sid, name: user.name ?? [user.firstName, user.lastName].filter(Boolean).join(' ') ?? 'Customer', kind: 'user' };
      }
    }
    return null;
  }

  /** store-credit balance (when the credit ledger is live) and loyalty points of one customer */
  async balances(storeId: string, ledgerId: string) {
    const out: any = { creditBalanceMinor: null, loyaltyPoints: 0, loyaltyTier: null };
    try {
      if (this.credit && this.credit.mode === 'new') { const c = await this.credit.ledger.currencyOf(storeId); out.creditBalanceMinor = await this.credit.ledger.balanceMinor(storeId, ledgerId, c.currency); }
      const m: any = await this.r.loyaltyMemberModel.findOne({ storeId, userId: ledgerId }).select('pointsBalance currentTier').lean();
      if (m) { out.loyaltyPoints = m.pointsBalance ?? 0; out.loyaltyTier = m.currentTier ?? null; }
    } catch { /* balances are a convenience; the directory still answers */ }
    return out;
  }

  // ── pieces the sale path uses ─────────────────────────────────────────────────────────────────────────────────
  requireLedger() {
    if (!this.credit || this.credit.mode !== 'new') throw new ConflictException({ statusCode: 409, code: 'STORE_CREDIT_NOT_ENABLED', message: 'Store credit is not switched on yet for this store' });
  }
  get creditEnabled(): boolean { return !!this.credit && this.credit.mode === 'new'; }
  get ledger() { return this.credit!.ledger; }

  async loyaltyConfig(storeId: string) {
    const p: any = await this.r.loyaltyProgramModel.findOne({ storeId }).lean();
    return { enabled: !!p?.isEnabled, earnSpendMinor: p?.posEarnSpendMinor ?? null, redeemMinorPerPoint: p?.posRedeemMinorPerPoint ?? null, tiers: (p?.tiers ?? []) as Array<{ name: string; minPoints: number }> };
  }

  /** Takes [points] from the member — atomic and guarded, inside the sale's transaction. */
  async redeemPointsInTx(tx: ClientSession | undefined, a: { storeId: string; ledgerId: string; points: number; saleId: string; description: string }) {
    const m: any = await this.r.loyaltyMemberModel.findOneAndUpdate({ storeId: a.storeId, userId: a.ledgerId, pointsBalance: { $gte: a.points } }, { $inc: { pointsBalance: -a.points }, $set: { lastActivityAt: new Date() } }, { new: true, ...(tx ? { session: tx } : {}) });
    if (!m) throw new ConflictException({ statusCode: 409, code: 'LOYALTY_INSUFFICIENT_POINTS', message: 'The customer does not have enough points' });
    await this.r.loyaltyTransactionModel.create([{ storeId: a.storeId, memberId: String(m._id), userId: a.ledgerId, type: 'redeem', points: -a.points, orderId: a.saleId, balanceAfter: m.pointsBalance, description: a.description }], tx ? { session: tx } : undefined);
  }

  /** Adds (or, negative, takes back) earned points; earned points also raise lifetime and the tier. Never below zero. */
  async earnInTx(tx: ClientSession | undefined, a: { storeId: string; ledgerId: string; points: number; saleId: string; description: string; tiers: Array<{ name: string; minPoints: number }>; type?: 'purchase' | 'adjustment' | 'redeem' }) {
    if (!a.points) return;
    const sess = tx ? { session: tx } : {};
    let m: any = await this.r.loyaltyMemberModel.findOne({ storeId: a.storeId, userId: a.ledgerId }).session(tx ?? null);
    if (!m) { [m] = await this.r.loyaltyMemberModel.create([{ storeId: a.storeId, userId: a.ledgerId, pointsBalance: 0, lifetimePoints: 0, currentTier: null }], sess); }
    const balance = Math.max(0, m.pointsBalance + a.points);
    const lifetime = a.points > 0 && (a.type ?? 'purchase') === 'purchase' ? m.lifetimePoints + a.points : m.lifetimePoints;
    const upd: any = { pointsBalance: balance, lifetimePoints: lifetime, lastActivityAt: new Date() };
    if (a.points > 0 && (a.type ?? 'purchase') === 'purchase') upd.currentTier = tierFor(lifetime, a.tiers);
    await this.r.loyaltyMemberModel.updateOne({ _id: m._id }, { $set: upd }, sess);
    await this.r.loyaltyTransactionModel.create([{ storeId: a.storeId, memberId: String(m._id), userId: a.ledgerId, type: a.type ?? (a.points > 0 ? 'purchase' : 'adjustment'), points: a.points, orderId: a.saleId, balanceAfter: balance, description: a.description }], sess);
  }
}
