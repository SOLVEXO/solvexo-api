/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { computeAvailableSlots } from './utils/slot-calculator.util';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { CreatePackageDto } from './dto/create-package.dto';
import { UpdatePackageDto } from './dto/update-package.dto';

/**
 * CRUD + buyer-facing browse/detail/slots for the Bookings domain's catalog
 * side (BookableService / ServiceAvailability / ServicePackage). Booking
 * lifecycle (book/cancel/reschedule/etc.) lives in `BookingsService` — split
 * purely to keep each file a manageable size, same reasoning as
 * Subscriptions splitting plans/subscribers out of one giant service.
 */
@Injectable()
export class BookableServicesService {
  constructor(private readonly db: DatabaseService) {}

  // ── Shorthand getters ────────────────────────────────────────────────────
  private get serviceModel()      { return this.db.repositories.bookableServiceModel; }
  private get availabilityModel() { return this.db.repositories.serviceAvailabilityModel; }
  private get packageModel()      { return this.db.repositories.servicePackageModel; }
  private get bookingModel()      { return this.db.repositories.bookingModel; }
  private get storeModel()        { return this.db.repositories.storeModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    return verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
  }

  private async verifyServiceInStore(storeId: string, serviceId: string) {
    const service = await this.serviceModel.findOne({ _id: serviceId, storeId, isDelete: false });
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  private slugify(name: string): string {
    const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
    return base || 'service';
  }

  private async uniqueSlug(storeId: string, name: string): Promise<string> {
    const base = this.slugify(name);
    let slug = base;
    let suffix = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await this.serviceModel.exists({ storeId, slug })) {
      slug = `${base}-${suffix++}`;
    }
    return slug;
  }

  private assertLocationConsistency(locationTypes: string[], inPersonAddress: any) {
    if (locationTypes.includes('in_person') && !inPersonAddress) {
      throw new BadRequestException('inPersonAddress is required when locationTypes includes "in_person"');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — SERVICES (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  async createService(sellerId: string, storeId: string, dto: CreateServiceDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    this.assertLocationConsistency(dto.locationTypes, dto.inPersonAddress);

    const slug = await this.uniqueSlug(storeId, dto.name);

    const service = await this.serviceModel.create({
      sellerId,
      storeId,
      name: dto.name,
      slug,
      description: dto.description ?? '',
      images: dto.images ?? [],
      categoryId: dto.categoryId ?? null,
      durationMinutes: dto.durationMinutes,
      price: dto.price,
      currency: dto.currency ?? 'USD',
      capacityPerSlot: dto.capacityPerSlot ?? 1,
      cancellationWindowHours: dto.cancellationWindowHours ?? 24,
      locationTypes: dto.locationTypes,
      inPersonAddress: dto.inPersonAddress ?? null,
      status: dto.status ?? 'draft',
    });

    return { success: true, data: service };
  }

  /** A service is only actually bookable once it has at least one weekly-hours rule — surfaced to the seller as `hasAvailability` so an empty schedule (the default for a brand-new service) doesn't silently sit unbookable. */
  private async annotateAvailability<T extends { _id: any }>(services: T[]): Promise<(T & { hasAvailability: boolean })[]> {
    const serviceIds = services.map((s) => s._id.toString());
    const availabilities = await this.availabilityModel.find({ serviceId: { $in: serviceIds } }).select('serviceId weeklyRules').lean();
    const withRules = new Set(
      availabilities.filter((a: any) => (a.weeklyRules ?? []).length > 0).map((a: any) => a.serviceId),
    );
    return services.map((s) => ({ ...s, hasAvailability: withRules.has(s._id.toString()) }));
  }

  async listServices(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const services = await this.serviceModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    return { success: true, data: await this.annotateAvailability(services) };
  }

  async getService(sellerId: string, storeId: string, serviceId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const service = await this.verifyServiceInStore(storeId, serviceId);
    const [annotated] = await this.annotateAvailability([service.toObject()]);
    return { success: true, data: annotated };
  }

  async updateService(sellerId: string, storeId: string, serviceId: string, dto: UpdateServiceDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const service = await this.verifyServiceInStore(storeId, serviceId);

    if (dto.name !== undefined) service.name = dto.name;
    if (dto.description !== undefined) service.description = dto.description;
    if (dto.images !== undefined) service.images = dto.images;
    if (dto.categoryId !== undefined) service.categoryId = dto.categoryId ?? null;
    if (dto.durationMinutes !== undefined) service.durationMinutes = dto.durationMinutes;
    if (dto.price !== undefined) service.price = dto.price;
    if (dto.currency !== undefined) service.currency = dto.currency;
    if (dto.capacityPerSlot !== undefined) service.capacityPerSlot = dto.capacityPerSlot;
    if (dto.cancellationWindowHours !== undefined) service.cancellationWindowHours = dto.cancellationWindowHours;
    if (dto.locationTypes !== undefined) service.locationTypes = dto.locationTypes;
    if (dto.inPersonAddress !== undefined) service.inPersonAddress = dto.inPersonAddress ?? null;
    if (dto.status !== undefined) service.status = dto.status;

    this.assertLocationConsistency(service.locationTypes, service.inPersonAddress);

    await service.save();
    const [annotated] = await this.annotateAvailability([service.toObject()]);
    return { success: true, data: annotated };
  }

  async archiveService(sellerId: string, storeId: string, serviceId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const service = await this.verifyServiceInStore(storeId, serviceId);
    service.isDelete = true;
    service.status = 'inactive';
    await service.save();
    return { success: true, message: 'Service deleted' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — AVAILABILITY (one doc per service)
  // ═══════════════════════════════════════════════════════════════════════════

  async getAvailability(sellerId: string, storeId: string, serviceId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    await this.verifyServiceInStore(storeId, serviceId);
    const availability = await this.availabilityModel.findOne({ serviceId }).lean();
    return { success: true, data: availability ?? { serviceId, storeId, weeklyRules: [], exceptions: [] } };
  }

  async setAvailability(sellerId: string, storeId: string, serviceId: string, dto: UpdateAvailabilityDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const service = await this.verifyServiceInStore(storeId, serviceId);

    const availability = await this.availabilityModel.findOneAndUpdate(
      { serviceId },
      {
        $set: {
          serviceId,
          sellerId,
          storeId: service.storeId,
          weeklyRules: dto.weeklyRules,
          exceptions: (dto.exceptions ?? []).map((e) => ({
            date: new Date(e.date),
            type: e.type,
            customStart: e.customStart ?? null,
            customEnd: e.customEnd ?? null,
          })),
        },
      },
      { upsert: true, new: true },
    );

    return { success: true, data: availability };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — PACKAGES (per service)
  // ═══════════════════════════════════════════════════════════════════════════

  async createPackage(sellerId: string, storeId: string, serviceId: string, dto: CreatePackageDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const service = await this.verifyServiceInStore(storeId, serviceId);

    const pkg = await this.packageModel.create({
      serviceId,
      sellerId,
      storeId,
      name: dto.name,
      sessionsCount: dto.sessionsCount,
      price: dto.price,
      currency: dto.currency ?? service.currency ?? 'USD',
      validityDays: dto.validityDays,
      status: 'active',
    });

    return { success: true, data: pkg };
  }

  async listPackages(sellerId: string, storeId: string, serviceId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    await this.verifyServiceInStore(storeId, serviceId);
    const packages = await this.packageModel.find({ serviceId }).sort({ createdAt: -1 }).lean();
    return { success: true, data: packages };
  }

  private async verifyPackageInService(storeId: string, serviceId: string, packageId: string) {
    const pkg = await this.packageModel.findOne({ _id: packageId, serviceId, storeId });
    if (!pkg) throw new NotFoundException('Package not found');
    return pkg;
  }

  async updatePackage(sellerId: string, storeId: string, serviceId: string, packageId: string, dto: UpdatePackageDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    await this.verifyServiceInStore(storeId, serviceId);
    const pkg = await this.verifyPackageInService(storeId, serviceId, packageId);

    if (dto.name !== undefined) pkg.name = dto.name;
    if (dto.sessionsCount !== undefined) pkg.sessionsCount = dto.sessionsCount;
    if (dto.price !== undefined) pkg.price = dto.price;
    if (dto.currency !== undefined) pkg.currency = dto.currency;
    if (dto.validityDays !== undefined) pkg.validityDays = dto.validityDays;
    if (dto.status !== undefined) pkg.status = dto.status;

    await pkg.save();
    return { success: true, data: pkg };
  }

  async archivePackage(sellerId: string, storeId: string, serviceId: string, packageId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    await this.verifyServiceInStore(storeId, serviceId);
    const pkg = await this.verifyPackageInService(storeId, serviceId, packageId);
    pkg.status = 'archived';
    await pkg.save();
    return { success: true, message: 'Package archived' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — PUBLIC BROWSE / DETAIL / SLOTS
  // ═══════════════════════════════════════════════════════════════════════════

  async browseServices(storeId: string) {
    const store = await this.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');

    const services = await this.serviceModel
      .find({ storeId, status: 'active', isDelete: false })
      .sort({ createdAt: -1 })
      .lean();

    return { success: true, data: services };
  }

  async getServiceDetail(storeId: string, serviceId: string) {
    const service = await this.serviceModel.findOne({ _id: serviceId, storeId, status: 'active', isDelete: false }).lean();
    if (!service) throw new NotFoundException('Service not found');

    const packages = await this.packageModel.find({ serviceId, status: 'active' }).lean();
    return { success: true, data: { ...service, packages } };
  }

  async getSlots(storeId: string, serviceId: string, dateStr: string) {
    if (!dateStr) throw new BadRequestException('date query parameter is required (YYYY-MM-DD)');

    const service = await this.serviceModel.findOne({ _id: serviceId, storeId, status: 'active', isDelete: false }).lean();
    if (!service) throw new NotFoundException('Service not found');

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    const availability = await this.availabilityModel.findOne({ serviceId }).lean();

    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
    const existingBookings = await this.bookingModel
      .find({ serviceId, date: { $gte: dayStart, $lte: dayEnd }, status: { $in: ['pending_payment', 'confirmed'] } })
      .select('startTime')
      .lean();

    const slots = computeAvailableSlots(
      availability as any,
      (service as any).durationMinutes,
      (service as any).capacityPerSlot,
      date,
      existingBookings as any,
    );

    return { success: true, data: slots };
  }
}
