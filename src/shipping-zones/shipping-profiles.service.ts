/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { CreateShippingProfileDto, UpdateShippingProfileDto } from './dto/shipping-profile.dto';

const MAX_PROFILES_PER_STORE = 100;

export interface ProfileOrigin {
  name: string;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string | null;
  latitude: number | null;
  longitude: number | null;
  locationId: string;
}

/**
 * Shopify shipping profiles. The General profile is implicit for every store (its zones/products carry no
 * profileId); its DB row only exists to hold the General profile's ship-from locations and is created lazily.
 */
@Injectable()
export class ShippingProfilesService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  /** Returns the store's General profile row, creating it on first use (race-safe via the partial unique index). */
  async ensureGeneral(storeId: string): Promise<any> {
    const model = this.repos.shippingProfileModel;
    const existing = await model.findOne({ storeId, isGeneral: true, isDelete: false }).lean();
    if (existing) return existing;
    try {
      const created = await model.create({ storeId, name: 'General profile', isGeneral: true, originLocationIds: [] });
      return created.toObject();
    } catch (e: any) {
      if (e?.code === 11000) {
        const again = await model.findOne({ storeId, isGeneral: true, isDelete: false }).lean();
        if (again) return again;
      }
      throw e;
    }
  }

  /** Validates a client-sent profile reference: empty / General => null, custom profile of this store => its id. */
  async resolveProfileRef(storeId: string, raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === '' || raw === 'general') return null;
    if (typeof raw !== 'string' || !isValidObjectId(raw)) throw new BadRequestException('Invalid shipping profile');
    const p: any = await this.repos.shippingProfileModel.findOne({ _id: raw, storeId, isDelete: false }).select('isGeneral').lean();
    if (!p) throw new NotFoundException('Shipping profile not found');
    return p.isGeneral ? null : String(p._id);
  }

  private async cleanLocationIds(storeId: string, ids?: string[]): Promise<string[]> {
    const unique = [...new Set((ids ?? []).map(String))];
    if (unique.length === 0) return [];
    const found = await this.repos.storeLocationModel.find({ _id: { $in: unique }, storeId, isDelete: false }).select('_id').lean();
    const ok = new Set(found.map((l: any) => String(l._id)));
    if (unique.some((id) => !ok.has(id))) throw new BadRequestException('One of the ship-from locations was not found.');
    return unique; // keep the seller's order: the first one is the primary origin
  }

  async list(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const general = await this.ensureGeneral(storeId);
    const profiles: any[] = await this.repos.shippingProfileModel.find({ storeId, isDelete: false }).sort({ isGeneral: -1, createdAt: 1 }).lean();
    const customIds = profiles.filter((p) => !p.isGeneral).map((p) => String(p._id));

    const [productAgg, zoneAgg, generalProducts, generalZones, locations] = await Promise.all([
      this.repos.productModel.aggregate([
        { $match: { storeId, isDelete: false, shippingProfileId: { $in: customIds } } },
        { $group: { _id: '$shippingProfileId', n: { $sum: 1 } } },
      ]),
      this.repos.shippingZoneModel.aggregate([
        { $match: { storeId, isDelete: false, profileId: { $in: customIds } } },
        { $group: { _id: '$profileId', n: { $sum: 1 } } },
      ]),
      // "General" = every physical product not on a (live) custom profile.
      this.repos.productModel.countDocuments({ storeId, isDelete: false, type: 'physical', shippingProfileId: { $nin: customIds } }),
      this.repos.shippingZoneModel.countDocuments({ storeId, isDelete: false, profileId: null }),
      this.repos.storeLocationModel.find({ storeId, isDelete: false, status: 'active' }).sort({ createdAt: 1 }).select('name city addressLine1 zipCode country type').lean(),
    ]);
    const productCount = new Map<string, number>(productAgg.map((r: any) => [String(r._id), r.n]));
    const zoneCount = new Map<string, number>(zoneAgg.map((r: any) => [String(r._id), r.n]));

    return {
      success: true,
      data: {
        generalProfileId: String(general._id),
        profiles: profiles.map((p) => ({
          _id: String(p._id),
          name: p.name,
          isGeneral: !!p.isGeneral,
          originLocationIds: p.originLocationIds ?? [],
          productCount: p.isGeneral ? generalProducts : productCount.get(String(p._id)) ?? 0,
          zoneCount: p.isGeneral ? generalZones : zoneCount.get(String(p._id)) ?? 0,
        })),
        locations: locations.map((l: any) => ({ _id: String(l._id), name: l.name, city: l.city ?? null, addressLine1: l.addressLine1 ?? null, zipCode: l.zipCode ?? null, country: l.country ?? null, type: l.type })),
      },
    };
  }

  async create(storeId: string, sellerId: string, dto: CreateShippingProfileDto) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    await this.ensureGeneral(storeId);
    const count = await this.repos.shippingProfileModel.countDocuments({ storeId, isDelete: false });
    if (count >= MAX_PROFILES_PER_STORE) throw new BadRequestException(`A store can have at most ${MAX_PROFILES_PER_STORE} shipping profiles.`);
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Profile name is required.');
    const profile = await this.repos.shippingProfileModel.create({
      storeId, name, isGeneral: false, originLocationIds: await this.cleanLocationIds(storeId, dto.originLocationIds),
    });
    await this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_profile_created', description: `Shipping profile "${name}" created`,
      actorId: sellerId, actorRole: 'seller', targetId: String(profile._id), targetType: 'shipping_profile',
    });
    return { success: true, message: 'Shipping profile created', data: profile };
  }

  async update(storeId: string, sellerId: string, profileId: string, dto: UpdateShippingProfileDto) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    if (!isValidObjectId(profileId)) throw new NotFoundException('Shipping profile not found');
    const profile: any = await this.repos.shippingProfileModel.findOne({ _id: profileId, storeId, isDelete: false }).lean();
    if (!profile) throw new NotFoundException('Shipping profile not found');
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      if (profile.isGeneral) throw new BadRequestException('The General profile cannot be renamed.');
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Profile name is required.');
      set.name = name;
    }
    if (dto.originLocationIds !== undefined) set.originLocationIds = await this.cleanLocationIds(storeId, dto.originLocationIds);
    if (Object.keys(set).length === 0) return { success: true, data: profile };
    const updated = await this.repos.shippingProfileModel.findOneAndUpdate({ _id: profileId, storeId, isDelete: false }, { $set: set }, { new: true });
    if (!updated) throw new NotFoundException('Shipping profile not found');
    await this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_profile_updated', description: `Shipping profile "${updated.name}" updated`,
      actorId: sellerId, actorRole: 'seller', targetId: profileId, targetType: 'shipping_profile',
    });
    return { success: true, message: 'Shipping profile updated', data: updated };
  }

  /**
   * Shopify: deleting a profile moves its products back to the General profile and removes the profile's own rates
   * (they are not carried over — General keeps its own rates untouched).
   */
  async remove(storeId: string, sellerId: string, profileId: string) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    if (!isValidObjectId(profileId)) throw new NotFoundException('Shipping profile not found');
    const profile: any = await this.repos.shippingProfileModel.findOne({ _id: profileId, storeId, isDelete: false }).lean();
    if (!profile) throw new NotFoundException('Shipping profile not found');
    if (profile.isGeneral) throw new BadRequestException('The General profile cannot be deleted.');
    const claimed = await this.repos.shippingProfileModel.updateOne({ _id: profileId, storeId, isDelete: false }, { $set: { isDelete: true } });
    if (claimed.modifiedCount === 0) throw new NotFoundException('Shipping profile not found');
    const [products, zones] = await Promise.all([
      this.repos.productModel.updateMany({ storeId, shippingProfileId: profileId }, { $set: { shippingProfileId: null } }),
      this.repos.shippingZoneModel.updateMany({ storeId, profileId, isDelete: false }, { $set: { isDelete: true } }),
    ]);
    await this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_profile_deleted', description: `Shipping profile "${profile.name}" deleted`,
      actorId: sellerId, actorRole: 'seller', targetId: profileId, targetType: 'shipping_profile',
    });
    return { success: true, message: 'Shipping profile deleted', data: { productsMovedToGeneral: products.modifiedCount, ratesRemoved: zones.modifiedCount } };
  }

  /** Moves the given physical products of this store into a profile ('general' / General id => General). */
  async assignProducts(storeId: string, sellerId: string, profileRef: string, productIds: string[]) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const target = await this.resolveProfileRef(storeId, profileRef);
    const ids = [...new Set((productIds ?? []).map(String))].filter((id) => isValidObjectId(id));
    if (ids.length === 0) throw new BadRequestException('Select at least one product.');
    const res = await this.repos.productModel.updateMany(
      { _id: { $in: ids }, storeId, type: 'physical', isDelete: false },
      { $set: { shippingProfileId: target } },
    );
    await this.activityLogService.log({
      storeId, category: 'settings', action: 'shipping_profile_products_assigned',
      description: `${res.modifiedCount} product(s) moved to ${target ? 'a custom shipping profile' : 'the General profile'}`,
      actorId: sellerId, actorRole: 'seller', targetId: target ?? 'general', targetType: 'shipping_profile',
    });
    return { success: true, message: 'Products updated', data: { matched: res.matchedCount, modified: res.modifiedCount } };
  }

  /** Seller product picker: physical products of the store, optionally filtered by name and/or current profile. */
  async searchProducts(storeId: string, sellerId: string, q?: string, profileRef?: string, limit = 30) {
    await verifyStoreOwnershipStrict(this.repos.storeModel, storeId, sellerId);
    const filter: Record<string, unknown> = { storeId, isDelete: false, type: 'physical' };
    const term = (q ?? '').trim().slice(0, 80);
    if (term) filter.name = { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (profileRef) {
      const target = await this.resolveProfileRef(storeId, profileRef);
      if (target) {
        filter.shippingProfileId = target;
      } else {
        // General = not on a live custom profile.
        const live = await this.repos.shippingProfileModel.find({ storeId, isDelete: false, isGeneral: false }).select('_id').lean();
        filter.shippingProfileId = { $nin: live.map((p: any) => String(p._id)) };
      }
    }
    const rows: any[] = await this.repos.productModel
      .find(filter).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), 100)).select('name images shippingProfileId status').lean();
    return {
      success: true,
      data: rows.map((p) => ({ _id: String(p._id), name: p.name, image: p.images?.[0] ?? null, shippingProfileId: p.shippingProfileId ?? null, status: p.status })),
    };
  }

  /**
   * Ship-from address for a profile (null profile = General): its first active location that has a full address.
   * Callers fall back to the Shippo integration's own `originAddress` when this is null (unchanged behaviour).
   */
  async resolveOrigin(storeId: string, profileId: string | null): Promise<ProfileOrigin | null> {
    const profile: any = profileId
      ? await this.repos.shippingProfileModel.findOne({ _id: profileId, storeId, isDelete: false }).select('originLocationIds').lean()
      : await this.repos.shippingProfileModel.findOne({ storeId, isGeneral: true, isDelete: false }).select('originLocationIds').lean();
    const ids: string[] = profile?.originLocationIds ?? [];
    if (ids.length === 0) return null;
    const locations: any[] = await this.repos.storeLocationModel.find({ _id: { $in: ids }, storeId, isDelete: false, status: 'active' }).lean();
    const byId = new Map(locations.map((l) => [String(l._id), l]));
    for (const id of ids) {
      const l = byId.get(id);
      if (l?.addressLine1 && l.city && l.zipCode && l.country) {
        return {
          name: l.name, street1: l.addressLine1, street2: l.addressLine2 ?? null, city: l.city, state: l.state ?? '',
          zip: l.zipCode, country: l.country, phone: l.phone ?? null,
          latitude: typeof l.latitude === 'number' ? l.latitude : null, longitude: typeof l.longitude === 'number' ? l.longitude : null,
          locationId: id,
        };
      }
    }
    return null;
  }

  /** Coordinates of the profile's first active origin location (for the local-delivery radius), regardless of a full address. */
  async resolveOriginCoords(storeId: string, profileId: string | null): Promise<{ latitude: number; longitude: number } | null> {
    const profile: any = profileId
      ? await this.repos.shippingProfileModel.findOne({ _id: profileId, storeId, isDelete: false }).select('originLocationIds').lean()
      : await this.repos.shippingProfileModel.findOne({ storeId, isGeneral: true, isDelete: false }).select('originLocationIds').lean();
    const ids: string[] = profile?.originLocationIds ?? [];
    if (ids.length === 0) return null;
    const locations: any[] = await this.repos.storeLocationModel.find({ _id: { $in: ids }, storeId, isDelete: false, status: 'active' }).select('latitude longitude').lean();
    const byId = new Map(locations.map((l) => [String(l._id), l]));
    for (const id of ids) {
      const l = byId.get(id);
      if (l && typeof l.latitude === 'number' && typeof l.longitude === 'number') return { latitude: l.latitude, longitude: l.longitude };
    }
    return null;
  }
}
