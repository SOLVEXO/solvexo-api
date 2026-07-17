/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

@Injectable()
export class MarketingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  async createCoupon(sellerId: string, storeId: string, dto: CreateCouponDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const code = dto.code.trim().toUpperCase();
    const existing = await this.r.couponModel.findOne({ storeId, code, isDelete: false });
    if (existing) throw new ConflictException(`Coupon code "${code}" already exists for this store`);

    if (dto.discountType === 'percentage' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    const coupon = await this.r.couponModel.create({
      storeId,
      sellerId,
      code,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      minOrderAmount: dto.minOrderAmount ?? null,
      usageLimit: dto.usageLimit ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const discountLabel = dto.discountType === 'percentage' ? `${dto.discountValue}% off` : `$${dto.discountValue} off`;
    const expiryLabel = coupon.expiresAt ? ` — expires ${coupon.expiresAt.toLocaleDateString()}` : '';

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'coupon_created',
      description: `${code} — ${discountLabel}${expiryLabel}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: String(coupon._id),
      targetType: 'coupon',
      ip,
      userAgent,
    });

    return { success: true, message: 'Coupon created', data: coupon };
  }

  async getCoupons(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

    const total = await this.r.couponModel.countDocuments(filter);
    const coupons = await this.r.couponModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    return { success: true, data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, coupons } };
  }

  async updateCoupon(sellerId: string, storeId: string, couponId: string, dto: UpdateCouponDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const coupon = await this.r.couponModel.findOne({ _id: couponId, storeId, isDelete: false });
    if (!coupon) throw new NotFoundException('Coupon not found');

    const update: any = {};
    if (dto.code !== undefined) update.code = dto.code.trim().toUpperCase();
    if (dto.discountType !== undefined) update.discountType = dto.discountType;
    if (dto.discountValue !== undefined) update.discountValue = dto.discountValue;
    if (dto.minOrderAmount !== undefined) update.minOrderAmount = dto.minOrderAmount;
    if (dto.usageLimit !== undefined) update.usageLimit = dto.usageLimit;
    if (dto.expiresAt !== undefined) update.expiresAt = new Date(dto.expiresAt);
    if (dto.isActive !== undefined) update.isActive = dto.isActive;

    const updated = await this.r.couponModel.findByIdAndUpdate(couponId, update, { new: true });

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: dto.isActive === false ? 'coupon_deactivated' : 'coupon_updated',
      description: `${(updated as any).code} updated`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: couponId,
      targetType: 'coupon',
      ip,
      userAgent,
    });

    return { success: true, message: 'Coupon updated', data: updated };
  }

  async deleteCoupon(sellerId: string, storeId: string, couponId: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const coupon = await this.r.couponModel.findOne({ _id: couponId, storeId, isDelete: false });
    if (!coupon) throw new NotFoundException('Coupon not found');

    await this.r.couponModel.findByIdAndUpdate(couponId, { isDelete: true, isActive: false });

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'coupon_deleted',
      description: `${coupon.code} deleted`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: couponId,
      targetType: 'coupon',
      ip,
      userAgent,
    });

    return { success: true, message: 'Coupon deleted' };
  }

  // ─── Platform-wide sale campaigns (admin-created, seller opt-in) ────────

  async getJoinableCampaigns(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const now = new Date();
    const campaigns = await this.r.campaignModel
      .find({ isDelete: false, status: 'active', endDate: { $gte: now } })
      .sort({ startDate: 1 })
      .lean();

    const data = campaigns.map((c) => ({ ...c, isJoined: c.participatingStoreIds.includes(storeId) }));
    return { success: true, data };
  }

  async joinCampaign(sellerId: string, storeId: string, campaignId: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const campaign = await this.r.campaignModel.findOne({ _id: campaignId, isDelete: false, status: 'active' });
    if (!campaign) throw new NotFoundException('Campaign not found or not active');

    if (!campaign.participatingStoreIds.includes(storeId)) {
      await this.r.campaignModel.findByIdAndUpdate(campaignId, { $addToSet: { participatingStoreIds: storeId } });
    }

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'campaign_joined',
      description: `Joined platform campaign "${campaign.name}"`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: campaignId,
      targetType: 'campaign',
      ip,
      userAgent,
    });

    return { success: true, message: 'Joined campaign' };
  }

  async leaveCampaign(sellerId: string, storeId: string, campaignId: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const campaign = await this.r.campaignModel.findOne({ _id: campaignId, isDelete: false });
    if (!campaign) throw new NotFoundException('Campaign not found');

    await this.r.campaignModel.findByIdAndUpdate(campaignId, { $pull: { participatingStoreIds: storeId } });

    this.activityLogService.log({
      storeId,
      category: 'marketing',
      action: 'campaign_left',
      description: `Left platform campaign "${campaign.name}"`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: campaignId,
      targetType: 'campaign',
      ip,
      userAgent,
    });

    return { success: true, message: 'Left campaign' };
  }

  // ─── Public consumption (buyer marketplace/homepage banner) ────────────
  async getPublicActiveCampaigns() {
    const now = new Date();
    const campaigns = await this.r.campaignModel
      .find({ isDelete: false, status: 'active', startDate: { $lte: now }, endDate: { $gte: now } })
      .sort({ endDate: 1 })
      .lean();

    const data = campaigns.map((c) => ({
      _id: c._id,
      name: c.name,
      description: c.description,
      bannerImage: c.bannerImage,
      endDate: c.endDate,
      discountType: c.discountType,
      discountValue: c.discountValue,
      storeCount: c.participatingStoreIds.length,
    }));
    return { success: true, data };
  }
}
