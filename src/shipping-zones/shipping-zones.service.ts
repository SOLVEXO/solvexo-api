/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';

/**
 * Admin-only CRUD over `ShippingZone` — previously this schema had zero
 * write path anywhere in the codebase (confirmed by grep: only
 * `checkout.service.ts`'s `addShippingInCheckout` ever READ it). Every
 * shipping rate on the platform could only ever be created via direct DB
 * manipulation. `ShippingZone` has no `storeId`/`sellerId` at the schema
 * level — it's a single platform-wide rate table (by country/province/city),
 * not per-seller, so this stays admin-only rather than inventing per-store
 * scoping the schema doesn't support.
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

  async list(query: { status?: string; country?: string }) {
    const filter: Record<string, unknown> = { isDelete: false };
    if (query.status && query.status !== 'all') filter.status = query.status;
    if (query.country) filter.country = query.country;
    const zones = await this.model.find(filter).sort({ country: 1, province: 1, city: 1 }).lean();
    return { success: true, data: zones };
  }

  async create(adminId: string, dto: CreateShippingZoneDto) {
    const zone = await this.model.create({
      country: dto.country,
      province: dto.province ?? null,
      city: dto.city ?? null,
      shippingPrice: dto.shippingPrice,
      estimatedDeliveryTime: dto.estimatedDeliveryTime ?? undefined,
      status: dto.status ?? 'active',
    });

    await this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action: 'shipping_zone_created',
      description: `${dto.country}${dto.province ? `, ${dto.province}` : ''}${dto.city ? `, ${dto.city}` : ''} — ${dto.shippingPrice}`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: String(zone._id),
      targetType: 'shipping_zone',
    });

    return { success: true, message: 'Shipping zone created', data: zone };
  }

  async update(adminId: string, zoneId: string, dto: UpdateShippingZoneDto) {
    const zone = await this.model.findOneAndUpdate(
      { _id: zoneId, isDelete: false },
      { $set: dto },
      { new: true },
    );
    if (!zone) throw new NotFoundException('Shipping zone not found');

    await this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action: 'shipping_zone_updated',
      description: `${zone.country}${zone.province ? `, ${zone.province}` : ''} updated`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: zoneId,
      targetType: 'shipping_zone',
    });

    return { success: true, message: 'Shipping zone updated', data: zone };
  }

  async remove(adminId: string, zoneId: string) {
    const zone = await this.model.findOneAndUpdate(
      { _id: zoneId, isDelete: false },
      { $set: { isDelete: true } },
      { new: true },
    );
    if (!zone) throw new NotFoundException('Shipping zone not found');

    await this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action: 'shipping_zone_deleted',
      description: `${zone.country}${zone.province ? `, ${zone.province}` : ''} deleted`,
      actorId: adminId,
      actorRole: 'admin',
      targetId: zoneId,
      targetType: 'shipping_zone',
    });

    return { success: true, message: 'Shipping zone deleted' };
  }
}
