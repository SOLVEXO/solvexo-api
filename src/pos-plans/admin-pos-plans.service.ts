/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { DatabaseService } from '../database/databaseservice';
import { CreatePosPlanDto } from './dto/create-pos-plan.dto';
import { UpdatePosPlanDto } from './dto/update-pos-plan.dto';
import { PosPurchaseQueryDto } from './dto/pos-purchase-query.dto';
import { GrantPosPlanDto, RevokePosPlanDto } from './dto/manual-pos-plan.dto';

/** Who performed a manual action — written to the audit log with the reason. */
export interface AdminActor { adminId: string; email?: string | null; ip?: string | null; userAgent?: string | null }

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminPosPlansService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Latest accepted rate per currency (units per 1 USD); USD is always 1. Same source as AdminFinanceService. */
  private async getUsdRates(): Promise<Map<string, number>> {
    const rates = await this.r.exchangeRateModel.aggregate([
      { $match: { isRejected: false } },
      { $sort: { effectiveFrom: -1 } },
      { $group: { _id: '$currency', ratePerUSD: { $first: '$ratePerUSD' } } },
    ]);
    const map = new Map<string, number>(rates.map((r: any) => [r._id, r.ratePerUSD]));
    map.set('USD', 1);
    return map;
  }

  /** USD value of a native amount, or null when no FX rate exists (never the native number). */
  private toUsd(amount: number, currency: string, rates: Map<string, number>): number | null {
    const rate = rates.get(currency || 'USD');
    return rate && rate > 0 ? Math.round((amount / rate) * 100) / 100 : null;
  }

  /** Active + inactive — admin needs to see retired plans too. Adds priceUSD (null = no FX rate set). */
  async listPlans() {
    const [plans, rates] = await Promise.all([
      this.r.posPlanModel.find().sort({ createdAt: -1 }),
      this.getUsdRates(),
    ]);
    const data = plans.map((p) => ({
      ...((p as any).toObject?.() ?? p),
      priceUSD: this.toUsd(p.price, p.currency, rates),
    }));
    return { success: true, data };
  }

  // ── Manual grant / extend / revoke ────────────────────────────────────────────────────────────────

  private async requireStore(storeId: string) {
    const store: any = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('name sellerId').lean();
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  private async latestPurchase(storeId: string): Promise<any> {
    return this.r.posPurchaseModel.findOne({ storeId }).sort({ purchasedAt: -1 }).lean();
  }

  private audit(actor: AdminActor, action: string, storeId: string, description: string, metadata: object) {
    return this.activityLog.log({
      category: 'admin_audit', action, description,
      actorId: actor.adminId, actorName: actor.email ?? null, actorRole: 'admin',
      targetId: storeId, targetType: 'store', ip: actor.ip ?? null, userAgent: actor.userAgent ?? null,
      metadata: { ...metadata, adminId: actor.adminId },
    });
  }

  private async createManualPurchase(store: any, storeId: string, dto: GrantPosPlanDto, actor: AdminActor, expiresAt: Date) {
    let planId = 'manual';
    let planName = 'Manual grant';
    if (dto.planId) {
      const plan: any = await this.r.posPlanModel.findById(dto.planId).lean();
      if (!plan) throw new NotFoundException('Plan not found');
      planId = String(plan._id);
      planName = `${plan.name} (manual)`;
    }
    return this.r.posPurchaseModel.create({
      storeId,
      sellerId: String(store.sellerId),
      planId,
      planNameSnapshot: planName,
      priceSnapshot: 0,
      currencySnapshot: 'USD',
      durationInDaysSnapshot: dto.days,
      stripeCheckoutSessionId: `manual:${new Types.ObjectId()}`,
      stripePaymentIntentId: null,
      purchasedAt: new Date(),
      expiresAt,
      source: 'manual',
      grantedByAdminId: actor.adminId,
      grantReason: dto.reason,
    });
  }

  /** Gives a store with NO active plan `days` days of POS access starting now. */
  async grantManually(dto: GrantPosPlanDto, actor: AdminActor) {
    const store = await this.requireStore(dto.storeId);
    const latest = await this.latestPurchase(dto.storeId);
    if (latest && new Date(latest.expiresAt).getTime() > Date.now()) {
      throw new BadRequestException('This store already has an active POS plan — use extend instead');
    }
    const expiresAt = new Date(Date.now() + dto.days * DAY_MS);
    const purchase = await this.createManualPurchase(store, dto.storeId, dto, actor, expiresAt);
    await this.audit(actor, 'pos_plan_granted', dto.storeId, `POS plan granted to "${store.name}" for ${dto.days} day(s): ${dto.reason}`,
      { days: dto.days, reason: dto.reason, expiresAt, purchaseId: String(purchase._id) });
    return { success: true, message: 'POS plan granted', data: purchase };
  }

  /** Adds `days` to a store's current expiry (or to now, if it lapsed). The new row becomes the latest purchase. */
  async extendManually(dto: GrantPosPlanDto, actor: AdminActor) {
    const store = await this.requireStore(dto.storeId);
    const latest = await this.latestPurchase(dto.storeId);
    const base = latest && new Date(latest.expiresAt).getTime() > Date.now() ? new Date(latest.expiresAt).getTime() : Date.now();
    const expiresAt = new Date(base + dto.days * DAY_MS);
    const purchase = await this.createManualPurchase(store, dto.storeId, dto, actor, expiresAt);
    await this.audit(actor, 'pos_plan_extended', dto.storeId, `POS plan for "${store.name}" extended by ${dto.days} day(s): ${dto.reason}`,
      { days: dto.days, reason: dto.reason, previousExpiresAt: latest?.expiresAt ?? null, expiresAt, purchaseId: String(purchase._id) });
    return { success: true, message: 'POS plan extended', data: purchase };
  }

  /** Ends a store's access immediately by expiring every still-running purchase (rows are kept for history). */
  async revokeManually(dto: RevokePosPlanDto, actor: AdminActor) {
    const store = await this.requireStore(dto.storeId);
    const now = new Date();
    const result = await this.r.posPurchaseModel.updateMany(
      { storeId: dto.storeId, expiresAt: { $gt: now } },
      { $set: { expiresAt: now, revokedAt: now, revokedByAdminId: actor.adminId, revokeReason: dto.reason } },
    );
    if (result.modifiedCount === 0) throw new BadRequestException('This store has no active POS plan to revoke');
    await this.audit(actor, 'pos_plan_revoked', dto.storeId, `POS plan revoked for "${store.name}": ${dto.reason}`,
      { reason: dto.reason, purchasesRevoked: result.modifiedCount });
    return { success: true, message: 'POS plan revoked', data: { storeId: dto.storeId, revoked: result.modifiedCount } };
  }

  async createPlan(dto: CreatePosPlanDto) {
    const plan = await this.r.posPlanModel.create({
      name: dto.name,
      price: dto.price,
      currency: dto.currency,
      durationInDays: dto.durationInDays,
      description: dto.description ?? null,
      isActive: true,
      maxRegisters: dto.maxRegisters ?? null,
      maxEmployees: dto.maxEmployees ?? null,
      maxLocations: dto.maxLocations ?? null,
    });
    return { success: true, message: 'Plan created', data: plan };
  }

  async updatePlan(id: string, dto: UpdatePosPlanDto) {
    const plan = await this.r.posPlanModel.findById(id);
    if (!plan) throw new NotFoundException('Plan not found');

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.price !== undefined) plan.price = dto.price;
    if (dto.currency !== undefined) plan.currency = dto.currency;
    if (dto.durationInDays !== undefined) plan.durationInDays = dto.durationInDays;
    if (dto.description !== undefined) plan.description = dto.description;
    if (dto.isActive !== undefined) plan.isActive = dto.isActive;
    if (dto.maxRegisters !== undefined) plan.maxRegisters = dto.maxRegisters;
    if (dto.maxEmployees !== undefined) plan.maxEmployees = dto.maxEmployees;
    if (dto.maxLocations !== undefined) plan.maxLocations = dto.maxLocations;

    await plan.save();
    return { success: true, message: 'Plan updated', data: plan };
  }

  /**
   * Paginated purchase history, joined with store/seller names for display
   * and text search — PosPurchase itself only stores ids, so a `search`
   * term is resolved against Store/Seller first to get a candidate id list
   * rather than via a DB-level join (kept simple; revisit with an
   * aggregation $lookup if this list's search becomes a hot path).
   */
  async listPurchases(query: PosPurchaseQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter: Record<string, unknown> = {};

    if (query.search) {
      const regex = { $regex: query.search, $options: 'i' };
      const [matchingStores, matchingSellers] = await Promise.all([
        this.r.storeModel.find({ name: regex }, { _id: 1 }),
        this.r.sellerModel.find({ name: regex }, { _id: 1 }),
      ]);
      const storeIds = matchingStores.map((s) => String(s._id));
      const sellerIds = matchingSellers.map((s) => String(s._id));
      filter.$or = [{ storeId: { $in: storeIds } }, { sellerId: { $in: sellerIds } }];
    }

    // status is derived from expiresAt rather than stored, but that's still
    // a plain indexed comparison — filtering at the query level (not
    // in-memory after pagination) keeps `total`/page size correct.
    if (query.status === 'active') filter.expiresAt = { $gt: new Date() };
    if (query.status === 'expired') filter.expiresAt = { $lte: new Date() };

    const [purchases, total] = await Promise.all([
      this.r.posPurchaseModel
        .find(filter)
        .sort({ purchasedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      this.r.posPurchaseModel.countDocuments(filter),
    ]);

    const storeIds = [...new Set(purchases.map((p) => p.storeId))];
    const sellerIds = [...new Set(purchases.map((p) => p.sellerId))];
    const [stores, sellers] = await Promise.all([
      this.r.storeModel.find({ _id: { $in: storeIds } }, { name: 1 }),
      this.r.sellerModel.find({ _id: { $in: sellerIds } }, { name: 1 }),
    ]);
    const storeNameById = new Map(stores.map((s) => [String(s._id), s.name]));
    const sellerNameById = new Map(sellers.map((s) => [String(s._id), s.name]));

    const rates = await this.getUsdRates();
    const now = Date.now();
    const items = purchases.map((p) => {
      const isActive = p.expiresAt.getTime() > now;
      return {
        id: String(p._id),
        sellerName: sellerNameById.get(p.sellerId) ?? 'Unknown seller',
        storeName: storeNameById.get(p.storeId) ?? 'Unknown store',
        planNameSnapshot: p.planNameSnapshot,
        // Admin sees USD only (converted at the latest rate; null = no FX rate set for that currency).
        priceUSD: this.toUsd(p.priceSnapshot, p.currencySnapshot, rates),
        purchasedAt: p.purchasedAt,
        expiresAt: p.expiresAt,
        daysRemaining: isActive ? Math.ceil((p.expiresAt.getTime() - now) / DAY_MS) : 0,
        status: isActive ? 'active' : 'expired',
      };
    });

    return { success: true, data: { items, total, page, limit } };
  }
}
