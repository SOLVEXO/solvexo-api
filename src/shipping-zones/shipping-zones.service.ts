/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';

/**
 * Per-store CRUD over `ShippingZone` — each store owns and manages its own
 * shipping zones/local-delivery rates (`storeId` set), verified via
 * `verifyStoreOwnershipStrict` on every call. There is no platform-wide
 * admin equivalent: the old admin-managed global zone table (and its
 * checkout-time fallback) was removed, since a genuinely independent
 * Shopify-style store is fully responsible for its own shipping setup.
 */
@Injectable()
export class ShippingZonesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() {
    return this.databaseService.repositories.shippingZoneModel;
  }

  // ── Seller (per-store) ───────────────────────────────────────────────────
  // Returns everything regardless of status (the seller's own management
  // view needs to see + toggle inactive zones too; buyer-facing checkout
  // filtering happens separately in CheckoutService).

  private get storeModel() {
    return this.databaseService.repositories.storeModel;
  }

  async listForSeller(storeId: string, sellerId: string, zoneType?: 'shipping' | 'local_delivery') {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const filter: Record<string, unknown> = { storeId, isDelete: false };
    if (zoneType) filter.zoneType = zoneType;
    const zones = await this.model.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: zones };
  }

  async createForSeller(storeId: string, sellerId: string, dto: CreateShippingZoneDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const zone = await this.model.create({
      storeId,
      zoneType: dto.zoneType ?? 'shipping',
      country: dto.country,
      province: dto.province ?? null,
      city: dto.city ?? null,
      shippingPrice: dto.shippingPrice,
      estimatedDeliveryTime: dto.estimatedDeliveryTime ?? undefined,
      status: dto.status ?? 'active',
    });

    await this.activityLogService.log({
      storeId,
      category: 'settings',
      action: 'shipping_zone_created',
      description: `${dto.city ?? dto.country} — Rs${dto.shippingPrice}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: String(zone._id),
      targetType: 'shipping_zone',
    });

    return { success: true, message: 'Shipping zone created', data: zone };
  }

  async updateForSeller(storeId: string, sellerId: string, zoneId: string, dto: UpdateShippingZoneDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const zone = await this.model.findOneAndUpdate(
      { _id: zoneId, storeId, isDelete: false },
      { $set: dto },
      { new: true },
    );
    if (!zone) throw new NotFoundException('Shipping zone not found');

    await this.activityLogService.log({
      storeId,
      category: 'settings',
      action: 'shipping_zone_updated',
      description: `${zone.city ?? zone.country} updated`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: zoneId,
      targetType: 'shipping_zone',
    });

    return { success: true, message: 'Shipping zone updated', data: zone };
  }

  async removeForSeller(storeId: string, sellerId: string, zoneId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const zone = await this.model.findOneAndUpdate(
      { _id: zoneId, storeId, isDelete: false },
      { $set: { isDelete: true } },
      { new: true },
    );
    if (!zone) throw new NotFoundException('Shipping zone not found');

    await this.activityLogService.log({
      storeId,
      category: 'settings',
      action: 'shipping_zone_deleted',
      description: `${zone.city ?? zone.country} deleted`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: zoneId,
      targetType: 'shipping_zone',
    });

    return { success: true, message: 'Shipping zone deleted' };
  }
}
