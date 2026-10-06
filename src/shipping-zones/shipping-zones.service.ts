/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';
import { UpdateShippingZoneDto } from './dto/update-shipping-zone.dto';
import { validateRateTiers } from './shipping-rate.util';
import { cleanPostalCodes } from './shipping-zone-match.util';
import { ShippingProfilesService } from './shipping-profiles.service';

const ZONE_FIELDS = [
  'country', 'province', 'city', 'shippingPrice', 'estimatedDeliveryTime', 'status', 'zoneType',
  'name', 'rateType', 'rateTiers', 'freeShippingThreshold', 'pickupAddress', 'pickupInstructions',
  'minDays', 'maxDays', 'postalCodes', 'minOrderAmount', 'regionName', 'radiusKm',
] as const;

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
    private readonly profilesService: ShippingProfilesService,
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

  // `profileId`: omitted = every zone of the store (legacy behaviour); 'general' = the General profile's zones;
  // a profile id = that profile's zones.
  async listForSeller(storeId: string, sellerId: string, zoneType?: 'shipping' | 'local_delivery' | 'pickup', profileId?: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const filter: Record<string, unknown> = { storeId, isDelete: false };
    if (zoneType) filter.zoneType = zoneType;
    if (profileId) filter.profileId = await this.profilesService.resolveProfileRef(storeId, profileId);
    const zones = await this.model.find(filter).sort({ createdAt: -1 }).lean();
    return { success: true, data: zones };
  }

  private assertDays(min?: number | null, max?: number | null) {
    if (min != null && max != null && max < min) throw new BadRequestException('Maximum delivery days must be at least the minimum.');
  }

  async createForSeller(storeId: string, sellerId: string, dto: CreateShippingZoneDto) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    this.assertDays(dto.minDays, dto.maxDays);
    const rateType = dto.zoneType === 'pickup' ? 'flat' : (dto.rateType ?? 'flat');
    const tierError = validateRateTiers(rateType, dto.rateTiers as any);
    if (tierError) throw new BadRequestException(tierError);
    const profileId = await this.profilesService.resolveProfileRef(storeId, dto.profileId);
    const zone = await this.model.create({
      storeId,
      profileId,
      regionName: dto.regionName?.trim() || null,
      radiusKm: dto.zoneType === 'local_delivery' ? (dto.radiusKm ?? null) : null,
      zoneType: dto.zoneType ?? 'shipping',
      name: dto.name?.trim() || null,
      country: dto.country,
      province: dto.province ?? null,
      city: dto.city ?? null,
      shippingPrice: dto.zoneType === 'pickup' ? 0 : dto.shippingPrice,
      rateType,
      rateTiers: rateType === 'flat' ? [] : (dto.rateTiers ?? []).map((t) => ({ min: t.min, max: t.max ?? null, price: t.price })),
      freeShippingThreshold: dto.freeShippingThreshold ?? null,
      pickupAddress: dto.pickupAddress?.trim() || null,
      pickupInstructions: dto.pickupInstructions?.trim() || null,
      minDays: dto.minDays ?? null,
      maxDays: dto.maxDays ?? null,
      postalCodes: dto.zoneType === 'local_delivery' ? cleanPostalCodes(dto.postalCodes) : [],
      minOrderAmount: dto.zoneType === 'pickup' ? null : (dto.minOrderAmount ?? null),
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
    const existing = await this.model.findOne({ _id: zoneId, storeId, isDelete: false }).lean();
    if (!existing) throw new NotFoundException('Shipping zone not found');
    const set: Record<string, unknown> = {};
    for (const k of ZONE_FIELDS) if ((dto as any)[k] !== undefined) set[k] = (dto as any)[k];
    if (set.postalCodes !== undefined) set.postalCodes = cleanPostalCodes(set.postalCodes as string[]);
    if (typeof set.regionName === 'string') set.regionName = (set.regionName as string).trim() || null;
    if ((dto as any).profileId !== undefined) set.profileId = await this.profilesService.resolveProfileRef(storeId, (dto as any).profileId);
    this.assertDays(
      (set.minDays as number | null | undefined) ?? (existing as any).minDays,
      (set.maxDays as number | null | undefined) ?? (existing as any).maxDays,
    );
    if (typeof set.name === 'string') set.name = (set.name as string).trim() || null;
    const finalType = (set.zoneType as string) ?? (existing as any).zoneType;
    if (finalType === 'pickup') { set.shippingPrice = 0; set.rateType = 'flat'; set.rateTiers = []; set.minOrderAmount = null; }
    if (finalType !== 'local_delivery') { set.postalCodes = []; set.radiusKm = null; }
    const finalRateType = (set.rateType as string) ?? (existing as any).rateType ?? 'flat';
    const finalTiers = (set.rateTiers as any) ?? (existing as any).rateTiers;
    const tierError = validateRateTiers(finalRateType, finalTiers);
    if (tierError) throw new BadRequestException(tierError);
    if (finalRateType === 'flat') set.rateTiers = [];
    const zone = await this.model.findOneAndUpdate(
      { _id: zoneId, storeId, isDelete: false },
      { $set: set },
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
