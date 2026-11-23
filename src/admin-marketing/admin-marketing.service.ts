/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CreatePlatformCouponDto } from './dto/create-platform-coupon.dto';
import { UpdatePlatformCouponDto } from './dto/update-platform-coupon.dto';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AdminMarketingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private log(action: string, description: string, meta: AuditMeta, targetId?: string) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'marketing',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  // ─── Platform-wide coupons (scope: 'platform') ──────────────────────────

  async createPlatformCoupon(dto: CreatePlatformCouponDto, meta: AuditMeta) {
    const code = dto.code.trim().toUpperCase();
    const existing = await this.r.couponModel.findOne({ scope: 'platform', code, isDelete: false });
    if (existing) throw new ConflictException(`Platform coupon code "${code}" already exists`);

    if (dto.discountType === 'percentage' && dto.discountValue > 100) {
      throw new BadRequestException('Percentage discount cannot exceed 100');
    }

    const coupon = await this.r.couponModel.create({
      scope: 'platform',
      adminId: meta.adminId,
      code,
      discountType: dto.discountType,
      discountValue: dto.discountValue,
      minOrderAmount: dto.minOrderAmount ?? null,
      usageLimit: dto.usageLimit ?? null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });

    this.log('platform_coupon_created', `Platform coupon "${code}" created`, meta, String(coupon._id));
    return { success: true, message: 'Platform coupon created', data: coupon };
  }

  async listPlatformCoupons() {
    const coupons = await this.r.couponModel.find({ scope: 'platform', isDelete: false }).sort({ createdAt: -1 });
    return { success: true, data: coupons };
  }

  private async findPlatformCouponOrThrow(id: string) {
    const coupon = await this.r.couponModel.findOne({ _id: id, scope: 'platform', isDelete: false });
    if (!coupon) throw new NotFoundException('Platform coupon not found');
    return coupon;
  }

  async updatePlatformCoupon(id: string, dto: UpdatePlatformCouponDto, meta: AuditMeta) {
    await this.findPlatformCouponOrThrow(id);
    const update: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      update[key] = key === 'expiresAt' ? new Date(value as string) : value;
    }
    const coupon = await this.r.couponModel.findByIdAndUpdate(id, { $set: update }, { new: true });
    this.log('platform_coupon_updated', `Platform coupon "${coupon!.code}" updated`, meta, id);
    return { success: true, message: 'Platform coupon updated', data: coupon };
  }

  async deletePlatformCoupon(id: string, meta: AuditMeta) {
    const coupon = await this.findPlatformCouponOrThrow(id);
    await this.r.couponModel.findByIdAndUpdate(id, { $set: { isDelete: true } });
    this.log('platform_coupon_deleted', `Platform coupon "${coupon.code}" deleted`, meta, id);
    return { success: true, message: 'Platform coupon deleted' };
  }
}
