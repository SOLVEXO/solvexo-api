/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from './entitlements.service';

/** How much the monthly allowance of a wallet goes UP when its plan's allowance is higher than the wallet remembers (an upgrade, or a trial store subscribing). */
export function upgradeExtra(walletAllowance: number, planAllowance: number): number {
  return Math.max(0, planAllowance - (walletAllowance ?? 0));
}

/**
 * What a monthly reset leaves in a wallet: the plan's allowance plus the BOUGHT credits that are still unspent.
 * Spending uses the monthly part first, so the bought part still there is whatever is left of the balance, up to what was bought.
 */
export function balanceAfterReset(allowance: number, balance: number, bonusBalance: number): { balance: number; bonus: number } {
  const keptBonus = Math.max(0, Math.min(bonusBalance ?? 0, balance ?? 0));
  return { balance: allowance + keptBonus, bonus: keptBonus };
}

/**
 * AI credit ledger of a store, filled from its PlatformPlan (`aiCreditsPerMonth`) and spent by AI Studio and the AI SEO
 * suggestions. The wallet follows the store's plan: it is created with the plan's allowance, brought in line the next time it
 * is used after a plan change (`alignToPlan`), and reset on the 1st of every month (bought credits are kept).
 */
@Injectable()
export class AiCreditsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get walletModel() { return this.db.repositories.aiCreditsWalletModel; }

  async getOrCreateWallet(storeId: string, sellerId: string) {
    const wallet = await this.walletModel.findOne({ storeId });
    if (!wallet) {
      const limits = await this.entitlements.getLimits(storeId);
      return this.walletModel.create({
        storeId, sellerId, balance: limits.aiCreditsPerMonth, monthlyAllowance: limits.aiCreditsPerMonth,
        lastResetAt: new Date(),
      });
    }
    return this.alignToPlan(wallet);
  }

  /**
   * A plan change (upgrade, downgrade, trial -> paid) must reach the wallet. A higher allowance is available straight away
   * (credits already used this month stay used); a lower one only lowers the allowance, because the balance can hold bought
   * credits that must not be taken away - the lower figure applies from the next monthly reset. Atomic and conditional on the
   * allowance the wallet had, so two requests aligning at once add the extra credits only once.
   */
  private async alignToPlan(wallet: any) {
    const { aiCreditsPerMonth } = await this.entitlements.getLimits(wallet.storeId);
    const before = wallet.monthlyAllowance ?? 0;
    if (aiCreditsPerMonth === before) return wallet;
    const extra = upgradeExtra(before, aiCreditsPerMonth);
    const update: any = { $set: { monthlyAllowance: aiCreditsPerMonth } };
    if (extra > 0) {
      update.$inc = { balance: extra };
      update.$push = { ledger: { type: 'grant', amount: extra, balanceAfter: wallet.balance + extra, reason: `Plan change: monthly allowance ${before} -> ${aiCreditsPerMonth}`, createdAt: new Date() } };
    }
    await this.walletModel.updateOne({ _id: wallet._id, monthlyAllowance: before }, update);
    return (await this.walletModel.findOne({ storeId: wallet.storeId })) ?? wallet;
  }

  async getBalance(storeId: string): Promise<number> {
    const wallet = await this.walletModel.findOne({ storeId }).lean();
    return (wallet as any)?.balance ?? 0;
  }

  /** Call before running an AI feature. Throws if the store doesn't have enough credits. */
  async deduct(storeId: string, sellerId: string, amount: number, reason: string): Promise<void> {
    const wallet = await this.getOrCreateWallet(storeId, sellerId);
    if (wallet.balance < amount) {
      throw new BadRequestException(`Not enough AI credits (need ${amount}, have ${wallet.balance}) — upgrade your platform plan or buy more credits.`);
    }
    wallet.balance -= amount;
    wallet.ledger.push({ type: 'spend', amount: -amount, balanceAfter: wallet.balance, reason, createdAt: new Date() });
    await wallet.save();
  }

  /** `purchased: true` marks credits the seller paid for (the extra-credits add-on): they survive the monthly reset until spent. */
  async grant(storeId: string, sellerId: string, amount: number, reason: string, opts?: { purchased?: boolean }): Promise<void> {
    const wallet = await this.getOrCreateWallet(storeId, sellerId);
    wallet.balance += amount;
    if (opts?.purchased) wallet.bonusBalance = (wallet.bonusBalance ?? 0) + amount;
    wallet.ledger.push({ type: opts?.purchased ? 'purchase' : 'grant', amount, balanceAfter: wallet.balance, reason, createdAt: new Date() });
    await wallet.save();
  }

  /** Runs monthly (cron) — resets every store's balance to its current plan's monthly allowance; credits the seller bought and has not spent are kept. */
  async resetAllMonthlyAllowances(): Promise<{ reset: number }> {
    const wallets = await this.walletModel.find({});
    let reset = 0;
    for (const wallet of wallets) {
      const limits = await this.entitlements.getLimits(wallet.storeId);
      const after = balanceAfterReset(limits.aiCreditsPerMonth, wallet.balance, wallet.bonusBalance ?? 0);
      wallet.monthlyAllowance = limits.aiCreditsPerMonth;
      wallet.balance = after.balance;
      wallet.bonusBalance = after.bonus;
      wallet.lastResetAt = new Date();
      wallet.ledger.push({
        type: 'reset', amount: limits.aiCreditsPerMonth, balanceAfter: wallet.balance,
        reason: after.bonus > 0 ? `Monthly allowance reset (${after.bonus} bought credits kept)` : 'Monthly allowance reset', createdAt: new Date(),
      });
      await wallet.save();
      reset++;
    }
    return { reset };
  }
}
