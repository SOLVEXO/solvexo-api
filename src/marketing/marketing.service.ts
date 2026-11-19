/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { importCouponsCsv } from './coupons-bulk-import';

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

    if (dto.customerSegmentId && !(await this.r.customerSegmentModel.exists({ _id: dto.customerSegmentId, storeId }))) {
      throw new BadRequestException('Customer segment not found for this store');
    }
    const coupon = await this.r.couponModel.create({
      storeId,
      sellerId,
      code,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      minOrderAmount: dto.minOrderAmount ?? null,
      usageLimit: dto.usageLimit ?? null,
      minQuantity: dto.minQuantity ?? null,
      oncePerCustomer: dto.oncePerCustomer === true,
      posEnabled: dto.posEnabled === true,
      customerSegmentId: dto.customerSegmentId ?? null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    const discountLabel = dto.discountType === 'percentage' ? `${dto.discountValue}% off` : `$ ${dto.discountValue} off`;
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

  /** Bulk CSV import — every row goes through createCoupon (same rules + activity log). */
  async importCouponsCsv(sellerId: string, storeId: string, text: string, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    return importCouponsCsv({ couponModel: this.r.couponModel, marketingService: this }, sellerId, storeId, text, ip, userAgent);
  }

  async getCoupons(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = parseInt(query.page) || 1;
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
    const search = typeof query.search === 'string' ? query.search.trim().slice(0, 60) : '';
    if (search) filter.code = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const total = await this.r.couponModel.countDocuments(filter);
    const coupons = await this.r.couponModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    return { success: true, data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, coupons } };
  }

  async updateCoupon(sellerId: string, storeId: string, couponId: string, dto: UpdateCouponDto, ip?: string, userAgent?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const coupon = await this.r.couponModel.findOne({ _id: couponId, storeId, isDelete: false });
    if (!coupon) throw new NotFoundException('Coupon not found');

    const update: any = {};
    if (dto.code !== undefined) {
      const code = dto.code.trim().toUpperCase();
      if (code !== coupon.code) {
        const clash = await this.r.couponModel.findOne({ storeId, code, isDelete: false, _id: { $ne: couponId } });
        if (clash) throw new ConflictException(`Coupon code "${code}" already exists for this store`);
      }
      update.code = code;
    }
    if (dto.discountType !== undefined) update.discountType = dto.discountType;
    if (dto.discountValue !== undefined) update.discountValue = dto.discountValue;
    if (dto.minOrderAmount !== undefined) update.minOrderAmount = dto.minOrderAmount;
    if (dto.usageLimit !== undefined) update.usageLimit = dto.usageLimit;
    if (dto.minQuantity !== undefined) update.minQuantity = dto.minQuantity;
    if (dto.oncePerCustomer !== undefined) update.oncePerCustomer = dto.oncePerCustomer;
    if (dto.posEnabled !== undefined) update.posEnabled = dto.posEnabled;
    if (dto.customerSegmentId !== undefined) {
      if (dto.customerSegmentId && !(await this.r.customerSegmentModel.exists({ _id: dto.customerSegmentId, storeId }))) {
        throw new BadRequestException('Customer segment not found for this store');
      }
      update.customerSegmentId = dto.customerSegmentId || null;
    }
    if (dto.startsAt !== undefined) update.startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    if (dto.expiresAt !== undefined) update.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const finalType = update.discountType ?? coupon.discountType;
    const finalValue = update.discountValue ?? coupon.discountValue;
    if (finalType === 'percentage' && finalValue > 100) throw new BadRequestException('Percentage discount cannot exceed 100');
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
}
