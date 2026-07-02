/* eslint-disable prettier/prettier */
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { AddPayoutMethodDto } from './dto/add-payout-method.dto';
import { UpdatePayoutScheduleDto } from './dto/update-payout-schedule.dto';

// ── Platform fee constants ───────────────────────────────────────────────────
const PLATFORM_FEE_RATE       = 0.08;   // 8% per sale
const PAYMENT_PROCESSING_RATE = 0.029;  // 2.9%
const PAYMENT_PROCESSING_FIXED = 0.30;  // $0.30 per transaction
const CLEARING_DAYS           = 3;      // days before pending → available
const ESTIMATED_TAX_RATE      = 0.15;   // 15% estimate shown in UI

@Injectable()
export class FinanceService {
  constructor(private readonly db: DatabaseService) {}

  // ── Shorthand repo getters ───────────────────────────────────────────────

  private get balanceModel()   { return this.db.repositories.sellerBalanceModel; }
  private get txModel()        { return this.db.repositories.transactionModel; }
  private get payoutModel()    { return this.db.repositories.payoutModel; }
  private get methodModel()    { return this.db.repositories.payoutMethodModel; }
  private get scheduleModel()  { return this.db.repositories.payoutScheduleModel; }
  private get taxModel()       { return this.db.repositories.taxReportModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private round(n: number) { return Math.round(n * 100) / 100; }

  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    const store = await this.db.repositories.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');
    if (store.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
    return store;
  }

  async getOrCreateBalance(storeId: string, sellerId: string) {
    let balance = await this.balanceModel.findOne({ storeId });
    if (!balance) {
      balance = await this.balanceModel.create({ storeId, sellerId });
    }
    return balance;
  }

  private async getOrCreateSchedule(storeId: string, sellerId: string) {
    let schedule = await this.scheduleModel.findOne({ storeId });
    if (!schedule) {
      // Compute next Monday as default nextPayoutAt
      const nextMonday = new Date();
      nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
      nextMonday.setHours(9, 0, 0, 0);
      schedule = await this.scheduleModel.create({ storeId, sellerId, nextPayoutAt: nextMonday });
    }
    return schedule;
  }

  /** Aggregate revenue and fee totals for a date range */
  private async getPeriodStats(storeId: string, from: Date, to: Date) {
    const agg = await this.txModel.aggregate([
      { $match: { storeId, status: 'completed', createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$type',
          total: { $sum: { $abs: '$amount' } },
          count: { $sum: 1 },
        },
      },
    ]);
    const stats: Record<string, number> = { sale: 0, fee: 0, refund: 0, payout: 0 };
    for (const row of agg) stats[row._id] = this.round(row.total);
    return stats;
  }

  /** Compute next scheduled payout date from current schedule */
  private computeNextPayoutDate(schedule: any): Date | null {
    const now = new Date();
    const next = new Date(now);

    if (schedule.frequency === 'weekly') {
      const target = schedule.dayOfWeek;
      const diff = (target + 7 - now.getDay()) % 7 || 7;
      next.setDate(now.getDate() + diff);
    } else if (schedule.frequency === 'biweekly') {
      next.setDate(now.getDate() + 14);
    } else if (schedule.frequency === 'monthly') {
      next.setMonth(now.getMonth() + 1);
      next.setDate(Math.min(schedule.dayOfMonth, 28));
    } else if (schedule.frequency === 'daily') {
      next.setDate(now.getDate() + 1);
    } else {
      return null;
    }
    next.setHours(9, 0, 0, 0);
    return next;
  }

  /** Get quarterly date range for a given year and period */
  private getPeriodDateRange(year: number, period: string): { from: Date; to: Date } {
    const ranges: Record<string, [number, number, number, number]> = {
      q1: [0, 1, 2, 31],
      q2: [3, 4, 5, 30],
      q3: [6, 7, 8, 30],
      q4: [9, 10, 11, 31],
    };
    if (period === 'annual') {
      return { from: new Date(year, 0, 1), to: new Date(year, 11, 31, 23, 59, 59) };
    }
    const [startMonth, , endMonth, endDay] = ranges[period];
    return {
      from: new Date(year, startMonth, 1),
      to: new Date(year, endMonth, endDay, 23, 59, 59),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  async getDashboard(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [balance, schedule, defaultMethod, pendingPayout, thisMonth, lastMonth] = await Promise.all([
      this.getOrCreateBalance(storeId, sellerId),
      this.getOrCreateSchedule(storeId, sellerId),
      this.methodModel.findOne({ storeId, isDefault: true }),
      this.payoutModel.findOne({ storeId, status: { $in: ['pending', 'processing'] } }).sort({ createdAt: -1 }),
      this.getPeriodStats(storeId, thisMonthStart, now),
      this.getPeriodStats(storeId, lastMonthStart, lastMonthEnd),
    ]);

    const revenueGrowth = lastMonth.sale > 0
      ? this.round(((thisMonth.sale - lastMonth.sale) / lastMonth.sale) * 100)
      : 0;

    return {
      availableBalance: balance.availableBalance,
      pendingBalance: balance.pendingBalance,
      currency: balance.currency,
      nextPayout: {
        pendingAmount: pendingPayout?.amount ?? null,
        scheduledAt: schedule.nextPayoutAt,
        method: defaultMethod
          ? { type: defaultMethod.type, bankName: defaultMethod.bankName, last4: defaultMethod.accountLast4 }
          : null,
      },
      summary: {
        thisMonthRevenue: thisMonth.sale,
        revenueGrowthPercent: revenueGrowth,
        platformFees: thisMonth.fee,
        totalPaidOut: balance.totalPayouts,
        pendingTax: this.round(thisMonth.sale * ESTIMATED_TAX_RATE),
      },
      payoutSchedule: {
        frequency: schedule.frequency,
        isEnabled: schedule.isEnabled,
        minimumAmount: schedule.minimumAmount,
        nextPayoutAt: schedule.nextPayoutAt,
      },
      feeBreakdown: {
        marketplaceListingFee: 'Free',
        transactionFee: `${PLATFORM_FEE_RATE * 100}% per sale`,
        paymentProcessing: `${PAYMENT_PROCESSING_RATE * 100}% + $${PAYMENT_PROCESSING_FIXED}`,
        digitalDelivery: 'Included',
        aiCredits: '750 / month',
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TRANSACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  async getTransactions(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const page  = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.type)    filter.type   = query.type;
    if (query.status)  filter.status = query.status;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to)   filter.createdAt.$lte = new Date(query.to);
    }

    const [transactions, total] = await Promise.all([
      this.txModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.txModel.countDocuments(filter),
    ]);

    return { transactions, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async exportTransactionsCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(sellerId, storeId);

    const filter: any = { storeId };
    if (query.type)  filter.type  = query.type;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to)   filter.createdAt.$lte = new Date(query.to);
    }

    const txs = await this.txModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const header = 'Date,Description,Type,Amount,Balance After,Status\n';
    const rows = txs.map((t: any) => {
      const date = new Date(t.createdAt).toISOString().split('T')[0];
      const amount = t.amount >= 0 ? `+$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`;
      return `"${date}","${t.description}","${t.type}","${amount}","$${t.balanceAfter.toFixed(2)}","${t.status}"`;
    }).join('\n');

    return header + rows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUTS
  // ═══════════════════════════════════════════════════════════════════════════

  async requestPayout(sellerId: string, storeId: string, dto: RequestPayoutDto) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const [balance, method] = await Promise.all([
      this.getOrCreateBalance(storeId, sellerId),
      this.methodModel.findById(dto.payoutMethodId),
    ]);

    if (!method || method.storeId !== storeId) throw new NotFoundException('Payout method not found');
    if (method.status !== 'active') throw new BadRequestException('Payout method is not active');
    if (dto.amount > balance.availableBalance) {
      throw new BadRequestException(`Insufficient balance — available: $${balance.availableBalance.toFixed(2)}`);
    }
    if (dto.amount < 1) throw new BadRequestException('Minimum payout amount is $1');

    // Deduct from available balance immediately
    const balanceBefore = balance.availableBalance;
    balance.availableBalance = this.round(balance.availableBalance - dto.amount);
    balance.totalPayouts = this.round(balance.totalPayouts + dto.amount);
    await balance.save();

    // Create payout record
    const payout = await this.payoutModel.create({
      storeId,
      sellerId,
      amount: dto.amount,
      payoutMethodId: dto.payoutMethodId,
      payoutMethodSnapshot: {
        type: method.type,
        bankName: method.bankName,
        accountLast4: method.accountLast4 ?? undefined,
      },
      notes: dto.notes || null,
      status: 'processing',
    });

    // Ledger entry
    await this.txModel.create({
      storeId,
      sellerId,
      type: 'payout',
      amount: -dto.amount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Payout — ${method.bankName || method.type} ••${method.accountLast4 || ''}`,
      referenceId: (payout as any)._id.toString(),
      referenceType: 'payout',
      status: 'completed',
    });

    return payout;
  }

  async getPayouts(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const page  = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.status) filter.status = query.status;

    const [payouts, total] = await Promise.all([
      this.payoutModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.payoutModel.countDocuments(filter),
    ]);
    return { payouts, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getPayoutById(sellerId: string, storeId: string, payoutId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const payout = await this.payoutModel.findOne({ _id: payoutId, storeId });
    if (!payout) throw new NotFoundException('Payout not found');
    return payout;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  async addPayoutMethod(sellerId: string, storeId: string, dto: AddPayoutMethodDto) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const isFirst = !(await this.methodModel.exists({ storeId }));

    const method = await this.methodModel.create({
      storeId,
      sellerId,
      type: dto.type,
      bankName: dto.bankName || null,
      accountHolder: dto.accountHolder || null,
      accountLast4: dto.accountNumber ? dto.accountNumber.slice(-4) : null,
      routingNumber: dto.routingNumber || null,
      externalAccountId: dto.externalAccountId || null,
      isDefault: dto.setAsDefault || isFirst,
    });

    // If this is set as default, unset others
    if (method.isDefault) {
      await this.methodModel.updateMany(
        { storeId, _id: { $ne: method._id } },
        { $set: { isDefault: false } },
      );
    }

    return method;
  }

  async getPayoutMethods(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    return this.methodModel.find({ storeId }).sort({ isDefault: -1, createdAt: -1 }).lean();
  }

  async updatePayoutMethod(sellerId: string, storeId: string, methodId: string, dto: AddPayoutMethodDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');

    if (dto.bankName !== undefined)    method.bankName    = dto.bankName;
    if (dto.accountHolder !== undefined) method.accountHolder = dto.accountHolder;
    if (dto.accountNumber)             method.accountLast4 = dto.accountNumber.slice(-4);
    if (dto.routingNumber !== undefined) method.routingNumber = dto.routingNumber;
    if (dto.externalAccountId !== undefined) method.externalAccountId = dto.externalAccountId;

    await method.save();
    return method;
  }

  async deletePayoutMethod(sellerId: string, storeId: string, methodId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');
    if (method.isDefault) throw new BadRequestException('Cannot delete the default payout method — set another as default first');
    await method.deleteOne();
    return { deleted: true };
  }

  async setDefaultPayoutMethod(sellerId: string, storeId: string, methodId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const method = await this.methodModel.findOne({ _id: methodId, storeId });
    if (!method) throw new NotFoundException('Payout method not found');

    await this.methodModel.updateMany({ storeId }, { $set: { isDefault: false } });
    method.isDefault = true;
    await method.save();
    return { isDefault: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYOUT SCHEDULE
  // ═══════════════════════════════════════════════════════════════════════════

  async getPayoutSchedule(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    return this.getOrCreateSchedule(storeId, sellerId);
  }

  async updatePayoutSchedule(sellerId: string, storeId: string, dto: UpdatePayoutScheduleDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const schedule = await this.getOrCreateSchedule(storeId, sellerId);

    if (dto.frequency !== undefined) schedule.frequency = dto.frequency;
    if (dto.dayOfWeek !== undefined) schedule.dayOfWeek = dto.dayOfWeek;
    if (dto.dayOfMonth !== undefined) schedule.dayOfMonth = dto.dayOfMonth;
    if (dto.minimumAmount !== undefined) schedule.minimumAmount = dto.minimumAmount;
    if (dto.isEnabled !== undefined) schedule.isEnabled = dto.isEnabled;
    if (dto.defaultPayoutMethodId !== undefined) schedule.defaultPayoutMethodId = dto.defaultPayoutMethodId;

    // Recompute next payout date
    const nextDate = this.computeNextPayoutDate(schedule);
    if (nextDate) schedule.nextPayoutAt = nextDate;

    await schedule.save();
    return schedule;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAX REPORTS
  // ═══════════════════════════════════════════════════════════════════════════

  async getTaxReports(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    return this.taxModel.find({ storeId }).sort({ year: -1, period: 1 }).lean();
  }

  async generateTaxReport(sellerId: string, storeId: string, year: number, period: string) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const validPeriods = ['q1', 'q2', 'q3', 'q4', 'annual'];
    if (!validPeriods.includes(period)) throw new BadRequestException('Invalid period — use q1, q2, q3, q4, or annual');

    const { from, to } = this.getPeriodDateRange(year, period);
    const stats = await this.getPeriodStats(storeId, from, to);
    const txCount = await this.txModel.countDocuments({ storeId, status: 'completed', createdAt: { $gte: from, $lte: to } });

    const netRevenue = this.round(stats.sale - stats.fee - stats.refund);
    const estimatedTax = this.round(netRevenue * ESTIMATED_TAX_RATE);

    const report = await this.taxModel.findOneAndUpdate(
      { storeId, year, period },
      {
        storeId, sellerId, year, period,
        fromDate: from, toDate: to,
        totalRevenue: stats.sale,
        totalFees: stats.fee,
        totalRefunds: stats.refund,
        totalPayouts: stats.payout,
        netRevenue,
        estimatedTax,
        transactionCount: txCount,
        generatedAt: new Date(),
      },
      { upsert: true, new: true },
    );

    return report;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════

  async getAnalytics(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const months = Math.min(12, parseInt(query.months) || 6);
    const now = new Date();

    // Build monthly revenue for last N months
    const monthlyData: Array<{ month: string; revenue: number; fees: number; refunds: number; net: number }> = [];
    for (let i = months - 1; i >= 0; i--) {
      const from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const to   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const stats = await this.getPeriodStats(storeId, from, to);
      monthlyData.push({
        month: from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        revenue: stats.sale,
        fees: stats.fee,
        refunds: stats.refund,
        net: this.round(stats.sale - stats.fee - stats.refund),
      });
    }

    // Overall balance summary
    const balance = await this.getOrCreateBalance(storeId, sellerId);

    // Payment type breakdown for current month
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthStats = await this.getPeriodStats(storeId, thisMonthStart, now);

    return {
      monthly: monthlyData,
      totals: {
        totalRevenue: balance.totalRevenue,
        totalFees: balance.totalFees,
        totalRefunds: balance.totalRefunds,
        totalPayouts: balance.totalPayouts,
        netRevenue: this.round(balance.totalRevenue - balance.totalFees - balance.totalRefunds),
      },
      currentMonth: thisMonthStats,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL — called by other modules (OrdersService, etc.)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a completed sale and deduct platform + processing fees.
   * Call this from OrdersService when an order is marked as completed.
   */
  async recordSale(storeId: string, sellerId: string, orderId: string, saleAmount: number, description: string) {
    const platformFee   = this.round(saleAmount * PLATFORM_FEE_RATE);
    const processingFee = this.round(saleAmount * PAYMENT_PROCESSING_RATE + PAYMENT_PROCESSING_FIXED);
    const netAmount     = this.round(saleAmount - platformFee - processingFee);

    const balance = await this.getOrCreateBalance(storeId, sellerId);
    const balanceBefore = balance.availableBalance;

    // Sale credit goes to pending for CLEARING_DAYS days
    balance.pendingBalance  = this.round(balance.pendingBalance + netAmount);
    balance.totalRevenue    = this.round(balance.totalRevenue + saleAmount);
    balance.totalFees       = this.round(balance.totalFees + platformFee + processingFee);
    await balance.save();

    // Ledger: sale entry
    await this.txModel.create({
      storeId, sellerId,
      type: 'sale',
      amount: saleAmount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: description || `Sale — Order #${orderId}`,
      referenceId: orderId,
      referenceType: 'order',
      status: 'pending',
      metadata: { platformFee, processingFee, netAmount, clearingDays: CLEARING_DAYS },
    });

    // Ledger: fee entry
    await this.txModel.create({
      storeId, sellerId,
      type: 'fee',
      amount: -(platformFee + processingFee),
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Platform Fee (${PLATFORM_FEE_RATE * 100}%) + Processing — Order #${orderId}`,
      referenceId: orderId,
      referenceType: 'order',
      status: 'completed',
    });
  }

  /**
   * Record a refund — reverses the net sale amount from available or pending balance.
   * Call this from OrdersService when a refund is issued.
   */
  async recordRefund(storeId: string, sellerId: string, orderId: string, refundAmount: number) {
    const balance = await this.getOrCreateBalance(storeId, sellerId);
    const balanceBefore = balance.availableBalance;

    // Deduct from available first, then pending if not enough
    if (balance.availableBalance >= refundAmount) {
      balance.availableBalance = this.round(balance.availableBalance - refundAmount);
    } else {
      const fromAvailable = balance.availableBalance;
      balance.availableBalance = 0;
      balance.pendingBalance   = this.round(balance.pendingBalance - (refundAmount - fromAvailable));
    }
    balance.totalRefunds = this.round(balance.totalRefunds + refundAmount);
    await balance.save();

    await this.txModel.create({
      storeId, sellerId,
      type: 'refund',
      amount: -refundAmount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Refund — Order #${orderId}`,
      referenceId: orderId,
      referenceType: 'order',
      status: 'completed',
    });
  }
}
