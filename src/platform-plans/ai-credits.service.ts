/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from './entitlements.service';

/**
 * AI-feature credit ledger, gated by the store's PlatformPlan
 * (`aiCreditsPerMonth`). No real AI feature consumes this yet anywhere in
 * this codebase — this is the infrastructure so that whenever one is built,
 * it just calls `deduct()` and gets grant/balance/monthly-reset for free,
 * and the "AI Studio — N credits/mo" line on the pricing page has a real
 * backing store instead of being purely cosmetic.
 */
@Injectable()
export class AiCreditsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private get walletModel() { return this.db.repositories.aiCreditsWalletModel; }

  async getOrCreateWallet(storeId: string, sellerId: string) {
    let wallet = await this.walletModel.findOne({ storeId });
    if (!wallet) {
      const limits = await this.entitlements.getLimits(storeId);
      wallet = await this.walletModel.create({
        storeId, sellerId, balance: limits.aiCreditsPerMonth, monthlyAllowance: limits.aiCreditsPerMonth,
        lastResetAt: new Date(),
      });
    }
    return wallet;
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

  async grant(storeId: string, sellerId: string, amount: number, reason: string): Promise<void> {
    const wallet = await this.getOrCreateWallet(storeId, sellerId);
    wallet.balance += amount;
    wallet.ledger.push({ type: 'grant', amount, balanceAfter: wallet.balance, reason, createdAt: new Date() });
    await wallet.save();
  }

  /** Runs monthly (cron) — resets every store's balance to its current plan's monthly allowance. */
  async resetAllMonthlyAllowances(): Promise<{ reset: number }> {
    const wallets = await this.walletModel.find({});
    let reset = 0;
    for (const wallet of wallets) {
      const limits = await this.entitlements.getLimits(wallet.storeId);
      wallet.monthlyAllowance = limits.aiCreditsPerMonth;
      wallet.balance = limits.aiCreditsPerMonth;
      wallet.lastResetAt = new Date();
      wallet.ledger.push({ type: 'reset', amount: limits.aiCreditsPerMonth, balanceAfter: wallet.balance, reason: 'Monthly allowance reset', createdAt: new Date() });
      await wallet.save();
      reset++;
    }
    return { reset };
  }
}
