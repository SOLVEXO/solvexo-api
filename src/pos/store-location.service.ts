/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { CreateStoreLocationDto } from './dto/create-store-location.dto';
import { UpdateStoreLocationDto } from './dto/update-store-location.dto';

/** Multi-location POS — physical branches under one Store (see StoreLocation schema docs). */
@Injectable()
export class StoreLocationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get locationModel() { return this.db.repositories.storeLocationModel; }
  private get storeModel() { return this.db.repositories.storeModel; }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  async createLocation(sellerId: string, storeId: string, dto: CreateStoreLocationDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    await this.entitlementsService.assertCanAddLocation(storeId);

    const location = await this.locationModel.create({
      storeId, sellerId, name: dto.name,
      addressLine1: dto.addressLine1 ?? null, city: dto.city ?? null, phone: dto.phone ?? null,
      status: 'active',
    });

    this.activityLogService.log({
      storeId, category: 'settings', action: 'pos_location_added',
      description: `Branch "${location.name}" added`,
      actorId: sellerId, actorRole: 'seller',
      targetId: (location as any)._id.toString(), targetType: 'store_location',
    });

    return { success: true, data: location };
  }

  async listLocations(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const locations = await this.locationModel.find({ storeId, isDelete: false }).sort({ createdAt: 1 }).lean();
    return { success: true, data: locations };
  }

  async getLocationById(sellerId: string, storeId: string, locationId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const location = await this.locationModel.findOne({ _id: locationId, storeId, isDelete: false }).lean();
    if (!location) throw new NotFoundException('Location not found');
    return { success: true, data: location };
  }

  async updateLocation(sellerId: string, storeId: string, locationId: string, dto: UpdateStoreLocationDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const location = await this.locationModel.findOne({ _id: locationId, storeId, isDelete: false });
    if (!location) throw new NotFoundException('Location not found');

    if (dto.name !== undefined) location.name = dto.name;
    if (dto.addressLine1 !== undefined) location.addressLine1 = dto.addressLine1 ?? null;
    if (dto.city !== undefined) location.city = dto.city ?? null;
    if (dto.phone !== undefined) location.phone = dto.phone ?? null;
    if (dto.status !== undefined) location.status = dto.status;

    await location.save();
    return { success: true, data: location };
  }

  async archiveLocation(sellerId: string, storeId: string, locationId: string, force: boolean) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const location = await this.locationModel.findOne({ _id: locationId, storeId, isDelete: false });
    if (!location) throw new NotFoundException('Location not found');

    const [registerCount, employeeCount] = await Promise.all([
      this.storeModel.findById(storeId).select('registers').lean()
        .then((s: any) => (s?.registers ?? []).filter((r: any) => r.locationId === locationId).length),
      this.db.repositories.employeeModel.countDocuments({ storeId, locationId, isDelete: false }),
    ]);

    if ((registerCount > 0 || employeeCount > 0) && !force) {
      throw new BadRequestException(
        `This location has ${registerCount} register(s) and ${employeeCount} employee(s) assigned. Reassign them or pass ?force=true (they'll be left unassigned, not deleted).`,
      );
    }

    location.status = 'archived';
    await location.save();

    this.activityLogService.log({
      storeId, category: 'settings', action: 'pos_location_archived',
      description: `Branch "${location.name}" archived`,
      actorId: sellerId, actorRole: 'seller',
      targetId: locationId, targetType: 'store_location',
    });

    return { success: true, message: 'Location archived. Assigned registers/employees are unaffected.' };
  }

  /** Combined "all branches" comparison view — the second half of what the seller asked for. */
  async getLocationsOverview(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : new Date();

    const [locations, salesByLocation] = await Promise.all([
      this.locationModel.find({ storeId, isDelete: false }).lean(),
      this.db.repositories.saleModel.aggregate([
        { $match: { storeId, status: { $in: ['completed', 'partially_refunded'] }, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$locationId', totalSales: { $sum: '$total' }, transactionCount: { $sum: 1 } } },
      ]),
    ]);

    const salesMap = Object.fromEntries(salesByLocation.map((r: any) => [r._id ?? 'unassigned', r]));
    const locationRows = locations.map((loc: any) => {
      const stats = salesMap[loc._id.toString()];
      return {
        locationId: loc._id, name: loc.name, city: loc.city, status: loc.status,
        totalSales: stats?.totalSales ?? 0, transactionCount: stats?.transactionCount ?? 0,
      };
    });

    // Sales from registers/employees created before this feature existed (locationId: null).
    const unassigned = salesMap['unassigned'];
    if (unassigned) {
      locationRows.push({
        locationId: null as any, name: 'Unassigned (legacy)', city: null, status: 'active',
        totalSales: unassigned.totalSales, transactionCount: unassigned.transactionCount,
      });
    }

    return {
      success: true,
      data: {
        from, to,
        combinedTotalSales: locationRows.reduce((s, r) => s + r.totalSales, 0),
        combinedTransactionCount: locationRows.reduce((s, r) => s + r.transactionCount, 0),
        byLocation: locationRows,
      },
    };
  }
}
