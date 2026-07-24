/* eslint-disable prettier/prettier */
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { AddPayoutMethodDto } from './dto/add-payout-method.dto';
import { UpdatePayoutScheduleDto } from './dto/update-payout-schedule.dto';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { round } from 'src/common/number.util';
import { verifyStoreExists, verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';

// ── Platform fee constants ───────────────────────────────────────────────────
export const PLATFORM_FEE_RATE       = 0.08;   // 8% per sale
export const PAYMENT_PROCESSING_RATE = 0.029;  // 2.9%
export const PAYMENT_PROCESSING_FIXED = 0.30;  // $0.30 per transaction
export const CLEARING_DAYS           = 3;      // days before pending → available
const ESTIMATED_TAX_RATE      = 0.15;   // 15% estimate shown in UI

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  // ── Shorthand repo getters ───────────────────────────────────────────────

  private get balanceModel()   { return this.db.repositories.sellerBalanceModel; }
  private get txModel()        { return this.db.repositories.transactionModel; }
  private get payoutModel()    { return this.db.repositories.payoutModel; }
  private get methodModel()    { return this.db.repositories.payoutMethodModel; }
  private get scheduleModel()  { return this.db.repositories.payoutScheduleModel; }
  private get taxModel()       { return this.db.repositories.taxReportModel; }
  private get storeModel()     { return this.db.repositories.storeModel; }
  private get sellerModel()    { return this.db.repositories.sellerModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private round(n: number) { return round(n); }

  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    return verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
  }

  /** Admin-facing equivalent — admins may act on any store, so this only checks the store exists (not who owns it). */
  private async verifyStoreExistsForAdmin(storeId: string) {
    return verifyStoreExists(this.storeModel, storeId);
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

  /** Shared filter builder — used by the seller's own transaction list/export and by the admin platform-wide equivalents. */
  private buildTransactionFilter(query: any, extra?: Record<string, any>): Record<string, any> {
    const filter: Record<string, any> = { ...extra };
    if (query.type)    filter.type   = query.type;
    if (query.status)  filter.status = query.status;
    if (query.storeId) filter.storeId = query.storeId;
    if (query.sellerId) filter.sellerId = query.sellerId;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to)   filter.createdAt.$lte = new Date(query.to);
    }
    return filter;
  }

  /** Shared paginated transaction query — used by both the seller and admin transaction-list endpoints. */
  private async queryTransactions(filter: Record<string, any>, query: any, maxLimit = 100) {
    const page  = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(maxLimit, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      this.txModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.txModel.countDocuments(filter),
    ]);

    return { transactions, total, page, limit, pages: Math.ceil(total / limit) };
  }

  private transactionsToCsv(txs: any[]): string {
    const header = 'Date,Store,Description,Type,Amount,Balance After,Status\n';
    const rows = txs.map((t: any) => {
      const date = new Date(t.createdAt).toISOString().split('T')[0];
      const amount = t.amount >= 0 ? `+$${t.amount.toFixed(2)}` : `-$${Math.abs(t.amount).toFixed(2)}`;
      return `"${date}","${t.storeId}","${t.description}","${t.type}","${amount}","$${t.balanceAfter.toFixed(2)}","${t.status}"`;
    }).join('\n');
    return header + rows;
  }

  async getTransactions(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const filter = this.buildTransactionFilter(query, { storeId });
    return this.queryTransactions(filter, query);
  }

  async exportTransactionsCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(sellerId, storeId);
    const filter = this.buildTransactionFilter(query, { storeId });
    const txs = await this.txModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return this.transactionsToCsv(txs);
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

  async updatePayoutSchedule(sellerId: string, storeId: string, dto: UpdatePayoutScheduleDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const schedule = await this.getOrCreateSchedule(storeId, sellerId);
    const oldFrequency = schedule.frequency;

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

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'payout_schedule_changed',
      description: dto.frequency && dto.frequency !== oldFrequency
        ? `${oldFrequency} → ${dto.frequency} payout schedule`
        : 'Payout schedule updated',
      actorId: sellerId,
      actorRole: 'seller',
      targetType: 'payout_schedule',
      ip,
      userAgent,
    });

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
  // ADMIN — platform-wide drill-down + payout lifecycle management.
  // Admins act on any store, so these skip seller-ownership checks (existence
  // only, via `verifyStoreExistsForAdmin`) and skip storeId-scoping on ledger
  // queries where the admin explicitly wants a platform-wide view.
  // ═══════════════════════════════════════════════════════════════════════════

  async adminGetSellerFinancialDetails(storeId: string) {
    const store = await this.verifyStoreExistsForAdmin(storeId);

    const [balance, schedule, methods, recentPayouts, seller] = await Promise.all([
      this.getOrCreateBalance(storeId, store.sellerId),
      this.getOrCreateSchedule(storeId, store.sellerId),
      this.methodModel.find({ storeId }).sort({ isDefault: -1, createdAt: -1 }).lean(),
      this.payoutModel.find({ storeId }).sort({ createdAt: -1 }).limit(10).lean(),
      this.sellerModel.findById(store.sellerId).select('name email').lean(),
    ]);

    return {
      store: { storeId, name: store.name, sellerId: store.sellerId },
      seller: seller ? { name: (seller as any).name, email: (seller as any).email } : null,
      balance: {
        availableBalance: balance.availableBalance,
        pendingBalance: balance.pendingBalance,
        totalRevenue: balance.totalRevenue,
        totalFees: balance.totalFees,
        totalRefunds: balance.totalRefunds,
        totalPayouts: balance.totalPayouts,
        currency: balance.currency,
      },
      payoutSchedule: {
        frequency: schedule.frequency,
        isEnabled: schedule.isEnabled,
        minimumAmount: schedule.minimumAmount,
        nextPayoutAt: schedule.nextPayoutAt,
      },
      payoutMethods: methods,
      recentPayouts,
    };
  }

  async adminGetSellerTransactions(storeId: string, query: any) {
    await this.verifyStoreExistsForAdmin(storeId);
    const filter = this.buildTransactionFilter(query, { storeId });
    return this.queryTransactions(filter, query);
  }

  async adminGetPlatformTransactions(query: any) {
    const filter = this.buildTransactionFilter(query);
    return this.queryTransactions(filter, query);
  }

  async adminExportTransactionsCsv(query: any): Promise<string> {
    const filter = this.buildTransactionFilter(query);
    const txs = await this.txModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();
    return this.transactionsToCsv(txs);
  }

  async adminGetPayoutQueue(query: any) {
    const page  = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: Record<string, any> = {};
    if (query.status)   filter.status   = query.status;
    if (query.storeId)  filter.storeId  = query.storeId;
    if (query.sellerId) filter.sellerId = query.sellerId;

    const [payouts, total, statusRows] = await Promise.all([
      this.payoutModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.payoutModel.countDocuments(filter),
      this.payoutModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    ]);

    const statusCounts: Record<string, { count: number; amount: number }> = {
      pending: { count: 0, amount: 0 }, processing: { count: 0, amount: 0 },
      completed: { count: 0, amount: 0 }, failed: { count: 0, amount: 0 },
    };
    for (const row of statusRows as any[]) {
      if (statusCounts[row._id]) statusCounts[row._id] = { count: row.count, amount: this.round(row.amount) };
    }

    return { payouts, total, page, limit, pages: Math.ceil(total / limit), statusCounts };
  }

  /**
   * Marks a pending/processing payout as completed. There is no live payment-processor
   * integration anywhere in this codebase (payouts, like COD orders, are fulfilled
   * manually outside the app) — this records that an admin has confirmed the transfer
   * was actually sent via their bank/PayPal/Stripe dashboard. It does not itself move money.
   */
  async adminApprovePayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const payout = await this.payoutModel.findById(payoutId);
    if (!payout) throw new NotFoundException('Payout not found');
    if (!['pending', 'processing'].includes(payout.status)) {
      throw new BadRequestException(`Cannot approve a payout with status "${payout.status}"`);
    }

    payout.status = 'completed';
    payout.processedAt = new Date();
    await payout.save();

    this.activityLogService.log({
      storeId: payout.storeId,
      category: 'finance',
      action: 'payout_approved',
      description: `Payout of $${payout.amount.toFixed(2)} approved and marked completed`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: payoutId,
      targetType: 'payout',
      ip, userAgent,
    });

    return payout;
  }

  /** Rejects a pending/processing payout and returns the deducted funds to the seller's available balance via a reversing ledger entry (the original ledger history is never edited). */
  async adminRejectPayout(payoutId: string, adminId: string, reason: string, ip?: string, userAgent?: string) {
    const payout = await this.payoutModel.findById(payoutId);
    if (!payout) throw new NotFoundException('Payout not found');
    if (!['pending', 'processing'].includes(payout.status)) {
      throw new BadRequestException(`Cannot reject a payout with status "${payout.status}"`);
    }

    const balance = await this.getOrCreateBalance(payout.storeId, payout.sellerId);
    const balanceBefore = balance.availableBalance;
    balance.availableBalance = this.round(balance.availableBalance + payout.amount);
    balance.totalPayouts = this.round(balance.totalPayouts - payout.amount);
    await balance.save();

    payout.status = 'failed';
    payout.failureReason = reason;
    payout.processedAt = new Date();
    await payout.save();

    await this.txModel.create({
      storeId: payout.storeId,
      sellerId: payout.sellerId,
      type: 'adjustment',
      amount: payout.amount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Payout rejected — funds returned (${reason})`,
      referenceId: payoutId,
      referenceType: 'payout',
      status: 'completed',
      metadata: { rejectedBy: adminId, reason },
    });

    this.activityLogService.log({
      storeId: payout.storeId,
      category: 'finance',
      action: 'payout_rejected',
      description: `Payout of $${payout.amount.toFixed(2)} rejected — ${reason}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: payoutId,
      targetType: 'payout',
      ip, userAgent,
    });

    return payout;
  }

  /** Re-attempts a previously-rejected payout — re-deducts the balance (rejecting already refunded it) and puts it back into `processing`. */
  async adminRetryFailedPayout(payoutId: string, adminId: string, ip?: string, userAgent?: string) {
    const payout = await this.payoutModel.findById(payoutId);
    if (!payout) throw new NotFoundException('Payout not found');
    if (payout.status !== 'failed') throw new BadRequestException('Only failed payouts can be retried');

    const balance = await this.getOrCreateBalance(payout.storeId, payout.sellerId);
    if (payout.amount > balance.availableBalance) {
      throw new BadRequestException(
        `Cannot retry — available balance ($${balance.availableBalance.toFixed(2)}) is less than the payout amount ($${payout.amount.toFixed(2)})`,
      );
    }

    const balanceBefore = balance.availableBalance;
    balance.availableBalance = this.round(balance.availableBalance - payout.amount);
    balance.totalPayouts = this.round(balance.totalPayouts + payout.amount);
    await balance.save();

    payout.status = 'processing';
    payout.failureReason = null;
    payout.processedAt = null;
    await payout.save();

    await this.txModel.create({
      storeId: payout.storeId,
      sellerId: payout.sellerId,
      type: 'payout',
      amount: -payout.amount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Payout retry — ${payout.payoutMethodSnapshot?.bankName || payout.payoutMethodSnapshot?.type || 'payout method'}`,
      referenceId: payoutId,
      referenceType: 'payout',
      status: 'completed',
      metadata: { retriedBy: adminId },
    });

    this.activityLogService.log({
      storeId: payout.storeId,
      category: 'finance',
      action: 'payout_retried',
      description: `Payout of $${payout.amount.toFixed(2)} re-queued for processing`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: payoutId,
      targetType: 'payout',
      ip, userAgent,
    });

    return payout;
  }

  /** Admin-initiated off-cycle payout (corrections/manual reconciliation) — completed immediately, no approval step needed since an admin is the one creating it. */
  async adminCreateManualPayout(
    storeId: string, adminId: string,
    amount: number, payoutMethodId: string | undefined, notes: string | undefined,
    ip?: string, userAgent?: string,
  ) {
    const store = await this.verifyStoreExistsForAdmin(storeId);
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero');

    const balance = await this.getOrCreateBalance(storeId, store.sellerId);
    if (amount > balance.availableBalance) {
      throw new BadRequestException(`Insufficient balance — available: $${balance.availableBalance.toFixed(2)}`);
    }

    let methodSnapshot: { type: string; bankName: string | null; accountLast4?: string } = {
      type: 'manual', bankName: null, accountLast4: 'ADMIN',
    };
    let resolvedMethodId = 'admin-manual';
    if (payoutMethodId) {
      const method = await this.methodModel.findOne({ _id: payoutMethodId, storeId });
      if (!method) throw new NotFoundException('Payout method not found');
      methodSnapshot = { type: method.type, bankName: method.bankName, accountLast4: method.accountLast4 ?? undefined };
      resolvedMethodId = payoutMethodId;
    }

    const balanceBefore = balance.availableBalance;
    balance.availableBalance = this.round(balance.availableBalance - amount);
    balance.totalPayouts = this.round(balance.totalPayouts + amount);
    await balance.save();

    const payout = await this.payoutModel.create({
      storeId, sellerId: store.sellerId, amount,
      payoutMethodId: resolvedMethodId,
      payoutMethodSnapshot: methodSnapshot,
      notes: notes || 'Manual payout issued by admin',
      status: 'completed',
      processedAt: new Date(),
    });

    await this.txModel.create({
      storeId, sellerId: store.sellerId,
      type: 'payout',
      amount: -amount,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: notes || 'Manual payout (admin-initiated)',
      referenceId: (payout as any)._id.toString(),
      referenceType: 'payout',
      status: 'completed',
      metadata: { manualByAdmin: adminId },
    });

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'manual_payout_issued',
      description: `Admin issued a manual payout of $${amount.toFixed(2)}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: (payout as any)._id.toString(),
      targetType: 'payout',
      ip, userAgent,
    });

    return payout;
  }

  /**
   * Promotes sale transactions past the clearing window from `pendingBalance` to
   * `availableBalance` — previously `CLEARING_DAYS` was defined but nothing ever
   * acted on it, so pending balances never became payout-eligible. Idempotent:
   * once a transaction's status flips to `completed` it's excluded from the next run.
   * Invoked hourly by `SchedulerService` and exposed to admins as a manual trigger.
   */
  async processClearingBalances(): Promise<{ processed: number; totalAmount: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - CLEARING_DAYS);

    const pendingSales = await this.txModel.find({
      type: 'sale', status: 'pending', createdAt: { $lte: cutoff },
    }).lean();

    let processed = 0;
    let totalAmount = 0;

    for (const tx of pendingSales as any[]) {
      const netAmount = tx.metadata?.netAmount ?? 0;
      if (netAmount > 0) {
        const balance = await this.getOrCreateBalance(tx.storeId, tx.sellerId);
        balance.pendingBalance = this.round(Math.max(0, balance.pendingBalance - netAmount));
        balance.availableBalance = this.round(balance.availableBalance + netAmount);
        await balance.save();
        totalAmount = this.round(totalAmount + netAmount);
      }
      await this.txModel.updateOne({ _id: tx._id }, { $set: { status: 'completed' } });
      processed += 1;
    }

    return { processed, totalAmount };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL — called by other modules (OrdersService, etc.)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a completed sale and deduct platform + processing fees.
   * Call this from OrdersService when an order is marked as completed.
   *
   * The platform-fee rate is now resolved per-store from the store's
   * PlatformPlan (`transactionFeeRate`) instead of the flat `PLATFORM_FEE_RATE`
   * constant — this is the single biggest financial incentive to upgrade a
   * platform tier (3% → 1% → 0.5% → 0%). `PLATFORM_FEE_RATE` remains as the
   * fallback for a store with no platform-plan record yet (pre-launch stores).
   */
  /**
   * `platformSponsoredUSD` (default 0) is the portion of `saleAmount` that
   * came from a `sponsorType: 'platform'` campaign discount — the caller
   * (OrdersService) has already folded it INTO `saleAmount` so the seller is
   * credited as if that discount never happened; this param only controls
   * the extra audit-trail entry and the `campaignId`'s running subsidy
   * total below, it does not change the balance math itself.
   */
  async recordSale(
    storeId: string, sellerId: string, orderId: string, saleAmount: number, description: string,
    platformSponsoredUSD = 0, campaignId?: string | null,
  ) {
    const platformFeeRate = await this.entitlementsService.getTransactionFeeRate(storeId);
    const platformFee   = this.round(saleAmount * platformFeeRate);
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
      description: `Platform Fee (${(platformFeeRate * 100).toFixed(1)}%) + Processing — Order #${orderId}`,
      referenceId: orderId,
      referenceType: 'order',
      status: 'completed',
    });

    // Ledger: platform-subsidy audit entry — informational only, doesn't move
    // the balance again (already folded into `saleAmount`/netAmount above);
    // it exists purely so the seller's transaction history and the admin
    // finance dashboard can both explain why this sale paid out more than
    // the buyer's checkout total for that store.
    if (platformSponsoredUSD > 0) {
      await this.txModel.create({
        storeId, sellerId,
        type: 'platform_subsidy',
        amount: platformSponsoredUSD,
        balanceBefore: balance.availableBalance,
        balanceAfter: balance.availableBalance,
        description: `Platform-sponsored sale discount — Order #${orderId}`,
        referenceId: orderId,
        referenceType: 'order',
        status: 'completed',
        metadata: { campaignId: campaignId ?? null },
      });

      if (campaignId) {
        await this.db.repositories.campaignModel.findByIdAndUpdate(
          campaignId,
          { $inc: { totalPlatformSubsidyUSD: platformSponsoredUSD } },
        );
      }
    }
  }

  /**
   * Credits a seller's balance with their share of subscription revenue
   * collected from their own store's subscribers. Mirrors `recordSale`'s
   * ledger shape (pending → available after CLEARING_DAYS via the same
   * clearing cron) so subscription and order revenue behave identically
   * from the seller's point of view. `platformCommissionUSD` is passed in
   * already computed by the caller (SubscriptionsService), since the
   * commission rate for subscription revenue is configured independently
   * of the order-sale PLATFORM_FEE_RATE.
   */
  async recordSubscriptionRevenue(
    storeId: string, sellerId: string, invoiceId: string,
    sellerPayoutUSD: number, platformCommissionUSD: number, description: string,
  ) {
    const balance = await this.getOrCreateBalance(storeId, sellerId);
    const balanceBefore = balance.availableBalance;

    balance.pendingBalance = this.round(balance.pendingBalance + sellerPayoutUSD);
    balance.totalRevenue   = this.round(balance.totalRevenue + sellerPayoutUSD + platformCommissionUSD);
    balance.totalFees      = this.round(balance.totalFees + platformCommissionUSD);
    await balance.save();

    await this.txModel.create({
      storeId, sellerId,
      type: 'sale',
      amount: this.round(sellerPayoutUSD + platformCommissionUSD),
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description,
      referenceId: invoiceId,
      referenceType: 'subscription_invoice',
      status: 'pending',
      metadata: { platformCommissionUSD, sellerPayoutUSD, clearingDays: CLEARING_DAYS, revenueType: 'subscription' },
    });

    await this.txModel.create({
      storeId, sellerId,
      type: 'fee',
      amount: -platformCommissionUSD,
      balanceBefore,
      balanceAfter: balance.availableBalance,
      description: `Platform subscription commission — invoice reference ${invoiceId}`,
      referenceId: invoiceId,
      referenceType: 'subscription_invoice',
      status: 'completed',
    });
  }

  /**
   * Record a refund — reverses the net sale amount from available or pending balance.
   * Call this from OrdersService when a refund is issued.
   */
  async recordRefund(
    storeId: string, sellerId: string, referenceId: string, refundAmount: number,
    actorId?: string, actorRole?: string,
    opts?: { referenceType?: 'order' | 'subscription_invoice' | 'platform_plan_invoice'; description?: string; targetType?: string },
  ) {
    const referenceType = opts?.referenceType ?? 'order';
    const balance = await this.getOrCreateBalance(storeId, sellerId);
    const balanceBefore = balance.availableBalance;

    // Deduct from available first, then pending if not enough. Platform
    // commission already taken at sale/charge time is NOT refunded — the
    // seller absorbs the full refund amount, same policy as order refunds.
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
      description: opts?.description ?? `Refund — Order #${referenceId}`,
      referenceId,
      referenceType,
      status: 'completed',
    });

    this.activityLogService.log({
      storeId,
      category: 'finance',
      action: 'refund_issued',
      description: opts?.description ?? `Order #${referenceId} — $${refundAmount.toFixed(2)} refunded`,
      actorId: actorId ?? sellerId,
      actorRole: actorRole ?? 'seller',
      targetId: referenceId,
      targetType: opts?.targetType ?? 'order',
    });
  }
}
