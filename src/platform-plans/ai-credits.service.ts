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
    // ONE atomic conditional write: the balance is only lowered while it still covers the cost, so two generations started at the
    // same moment can never both spend the same credits (the old read-modify-write let both pass the check).
    const res: any = await this.walletModel.updateOne({ _id: wallet._id, balance: { $gte: amount } }, { $inc: { balance: -amount } });
    if (!res?.modifiedCount) {
      const now: any = await this.walletModel.findOne({ _id: wallet._id }).lean();
      throw new BadRequestException(`Not enough AI credits (need ${amount}, have ${now?.balance ?? 0}) — upgrade your platform plan or buy more credits.`);
    }
    await this.writeLedger(wallet._id, { type: 'spend', amount: -amount, reason });
  }

  /** `purchased: true` marks credits the seller paid for (the extra-credits add-on): they survive the monthly reset until spent. */
  async grant(storeId: string, sellerId: string, amount: number, reason: string, opts?: { purchased?: boolean }): Promise<void> {
    const wallet = await this.getOrCreateWallet(storeId, sellerId);
    const inc: Record<string, number> = { balance: amount };
    if (opts?.purchased) inc.bonusBalance = amount;
    await this.walletModel.updateOne({ _id: wallet._id }, { $inc: inc });
    await this.writeLedger(wallet._id, { type: opts?.purchased ? 'purchase' : 'grant', amount, reason });
  }

  /** The ledger line is a record, not the money: it is added after the balance moved, with the balance as it is then. */
  private async writeLedger(walletId: any, line: { type: string; amount: number; reason: string }) {
    const after: any = await this.walletModel.findOne({ _id: walletId }).lean();
    await this.walletModel.updateOne({ _id: walletId }, { $push: { ledger: { ...line, balanceAfter: after?.balance ?? 0, createdAt: new Date() } } });
  }

  /** Runs monthly (cron) — resets every store's balance to its current plan's monthly allowance; credits the seller bought and has not spent are kept. */
  async resetAllMonthlyAllowances(): Promise<{ reset: number }> {
    const wallets = await this.walletModel.find({}).lean();
    let reset = 0;
    for (const w of wallets as any[]) {
      const limits = await this.entitlements.getLimits(w.storeId);
      // Conditional on the balance that was read: if the store spent credits in the meantime, read again and recompute (never overwrite a newer balance).
      let current: any = w;
      for (let attempt = 0; attempt < 4 && current; attempt++) {
        const after = balanceAfterReset(limits.aiCreditsPerMonth, current.balance, current.bonusBalance ?? 0);
        const res: any = await this.walletModel.updateOne(
          { _id: current._id, balance: current.balance },
          {
            $set: { monthlyAllowance: limits.aiCreditsPerMonth, balance: after.balance, bonusBalance: after.bonus, lastResetAt: new Date() },
            $push: { ledger: {
              type: 'reset', amount: limits.aiCreditsPerMonth, balanceAfter: after.balance,
              reason: after.bonus > 0 ? `Monthly allowance reset (${after.bonus} bought credits kept)` : 'Monthly allowance reset', createdAt: new Date(),
            } },
          },
        );
        if (res?.modifiedCount) { reset++; break; }
        current = await this.walletModel.findOne({ _id: w._id }).lean();
      }
    }
    return { reset };
  }
}
