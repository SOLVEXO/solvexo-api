/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { CreatePosPlanDto } from './dto/create-pos-plan.dto';
import { UpdatePosPlanDto } from './dto/update-pos-plan.dto';
import { PosPurchaseQueryDto } from './dto/pos-purchase-query.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminPosPlansService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Active + inactive — admin needs to see retired plans too. */
  async listPlans() {
    const plans = await this.r.posPlanModel.find().sort({ createdAt: -1 });
    return { success: true, data: plans };
  }

  async createPlan(dto: CreatePosPlanDto) {
    const plan = await this.r.posPlanModel.create({
      name: dto.name,
      price: dto.price,
      currency: dto.currency,
      durationInDays: dto.durationInDays,
      description: dto.description ?? null,
      isActive: true,
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

    const now = Date.now();
    const items = purchases.map((p) => {
      const isActive = p.expiresAt.getTime() > now;
      return {
        id: String(p._id),
        sellerName: sellerNameById.get(p.sellerId) ?? 'Unknown seller',
        storeName: storeNameById.get(p.storeId) ?? 'Unknown store',
        planNameSnapshot: p.planNameSnapshot,
        priceSnapshot: p.priceSnapshot,
        currencySnapshot: p.currencySnapshot,
        purchasedAt: p.purchasedAt,
        expiresAt: p.expiresAt,
        daysRemaining: isActive ? Math.ceil((p.expiresAt.getTime() - now) / DAY_MS) : 0,
        status: isActive ? 'active' : 'expired',
      };
    });

    return { success: true, data: { items, total, page, limit } };
  }
}
