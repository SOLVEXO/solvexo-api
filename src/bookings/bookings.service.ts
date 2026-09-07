/* eslint-disable prettier/prettier */
import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { FinanceService } from '../finance/finance.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { computeAvailableSlots } from './utils/slot-calculator.util';
import { BookAppointmentDto } from './dto/book-appointment.dto';
import { RescheduleBookingDto } from './dto/reschedule-booking.dto';

/**
 * Booking lifecycle: book / purchasePackage / cancel / reschedule / confirm /
 * complete / seller-cancel / list / dashboard / my-bookings / my-packages.
 * Catalog CRUD (services/availability/packages) lives in
 * `BookableServicesService` — split purely to keep each file a manageable
 * size (mirrors how Subscriptions splits plans from subscribers).
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly financeService: FinanceService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ── Shorthand getters ────────────────────────────────────────────────────
  private get bookingModel()      { return this.db.repositories.bookingModel; }
  private get serviceModel()      { return this.db.repositories.bookableServiceModel; }
  private get availabilityModel() { return this.db.repositories.serviceAvailabilityModel; }
  private get packageModel()      { return this.db.repositories.servicePackageModel; }
  private get purchaseModel()     { return this.db.repositories.packagePurchaseModel; }
  private get storeModel()        { return this.db.repositories.storeModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private round(n: number) { return Math.round(n * 100) / 100; }

  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    return verifyStoreOwnershipOrForbidden(this.storeModel, storeId, sellerId);
  }

  /** Same "lazily create the provider customer" pattern SubscriptionsService.subscribe() uses. Returns null for the manual provider (it doesn't need one). */
  private async ensureProviderCustomerId(buyerId: string): Promise<string | null> {
    if (this.gateway.providerName !== 'stripe') return null;

    const user = await this.db.repositories.userModel.findById(buyerId);
    if (!user) throw new NotFoundException('Buyer account not found');

    if (!user.stripeCustomerId) {
      const { providerCustomerId } = await this.gateway.getOrCreateCustomer(buyerId, user.email, user.name ?? '');
      user.stripeCustomerId = providerCustomerId;
      await user.save();
    }
    return user.stripeCustomerId;
  }

  private dayBounds(date: Date): { dayStart: Date; dayEnd: Date } {
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
    return { dayStart, dayEnd };
  }

  private async findAvailableSlot(serviceId: string, durationMinutes: number, capacityPerSlot: number, date: Date, startTime: string, excludeBookingId?: string) {
    const availability = await this.availabilityModel.findOne({ serviceId }).lean();
    const { dayStart, dayEnd } = this.dayBounds(date);

    const filter: any = { serviceId, date: { $gte: dayStart, $lte: dayEnd }, status: { $in: ['pending_payment', 'confirmed'] } };
    if (excludeBookingId) filter._id = { $ne: excludeBookingId };

    const existingBookings = await this.bookingModel.find(filter).select('startTime').lean();
    const slots = computeAvailableSlots(availability as any, durationMinutes, capacityPerSlot, date, existingBookings as any);
    return slots.find((s) => s.startTime === startTime) ?? null;
  }

  private assertWithinCancellationWindow(booking: any, cancellationWindowHours: number) {
    const [h, m] = booking.startTime.split(':').map((n: string) => parseInt(n, 10));
    const bookingDateTime = new Date(booking.date);
    bookingDateTime.setHours(h, m, 0, 0);
    const hoursUntil = (bookingDateTime.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntil < cancellationWindowHours) {
      throw new BadRequestException(`This must be done at least ${cancellationWindowHours} hour(s) before the appointment`);
    }
  }

  /** Shared cancel-state transition — releases a redeemed package session back to the purchase, if any. No real-money refund is issued (matches this codebase's existing "no live Stripe charge-refund flow in the app path" limitation — see CLAUDE.md). */
  private async releaseBookingSlot(booking: any, status: string, reason?: string) {
    booking.status = status;
    booking.cancellationReason = reason ?? null;
    await booking.save();

    if (booking.packagePurchaseId) {
      const purchase = await this.purchaseModel.findById(booking.packagePurchaseId);
      if (purchase && purchase.status !== 'cancelled') {
        purchase.sessionsRemaining = Math.min(purchase.sessionsTotal, purchase.sessionsRemaining + 1);
        if (purchase.status === 'fully_used' && purchase.sessionsRemaining > 0) purchase.status = 'active';
        await purchase.save();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — BOOK / PURCHASE PACKAGE
  // ═══════════════════════════════════════════════════════════════════════════

  async book(buyerId: string, dto: BookAppointmentDto, idempotencyKey?: string) {
    const service = await this.serviceModel.findOne({ _id: dto.serviceId, status: 'active', isDelete: false });
    if (!service) throw new NotFoundException('Service not found or inactive');

    const store = await this.storeModel.findById(service.storeId);
    if (!store || store.isDelete || store.status !== 'active') {
      throw new BadRequestException('This store is not currently accepting bookings');
    }

    const date = new Date(dto.date);
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    const locationType = dto.locationType ?? service.locationTypes[0];
    if (!locationType || !service.locationTypes.includes(locationType)) {
      throw new BadRequestException(`This service does not support location type "${locationType}"`);
    }
    if (locationType === 'customer_address' && !dto.serviceAddress) {
      throw new BadRequestException('serviceAddress is required when booking a "customer_address" appointment');
    }

    const slot = await this.findAvailableSlot(dto.serviceId, service.durationMinutes, service.capacityPerSlot, date, dto.startTime);
    if (!slot) throw new BadRequestException('This time slot is not available');

    // ── Redeem against a purchased package instead of charging ──────────────
    let packagePurchase: any = null;
    let price = service.price;
    if (dto.packagePurchaseId) {
      packagePurchase = await this.purchaseModel.findOne({ _id: dto.packagePurchaseId, buyerId, serviceId: dto.serviceId });
      if (!packagePurchase) throw new NotFoundException('Package purchase not found for this service');
      if (packagePurchase.status !== 'active') throw new BadRequestException(`This package is "${packagePurchase.status}" and cannot be redeemed`);
      if (packagePurchase.expiresAt.getTime() < Date.now()) throw new BadRequestException('This package has expired');
      if (packagePurchase.sessionsRemaining <= 0) throw new BadRequestException('No sessions remaining on this package');
      price = 0;
    }

    let booking: any;
    try {
      booking = await this.bookingModel.create({
        serviceId: dto.serviceId,
        packagePurchaseId: dto.packagePurchaseId ?? null,
        sellerId: service.sellerId,
        storeId: service.storeId,
        buyerId,
        date,
        startTime: dto.startTime,
        endTime: slot.endTime,
        locationType,
        serviceAddress: dto.serviceAddress ?? null,
        meetingLink: null,
        price,
        currency: service.currency,
        paymentProvider: dto.packagePurchaseId ? null : this.gateway.providerName,
        status: 'pending_payment',
        buyerNote: dto.buyerNote ?? null,
      });
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('You already have a booking for this time slot');
      throw err;
    }

    const notifyConfirmed = () => this.notificationsService.notify({
      recipientId: buyerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.BOOKING_CONFIRMED,
      title: 'Booking confirmed',
      body: `Your booking for "${service.name}" on ${date.toDateString()} at ${dto.startTime} is confirmed.`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});

    // ── Package redemption path — no charge, no finance ledger entry ────────
    if (dto.packagePurchaseId) {
      packagePurchase.sessionsRemaining -= 1;
      if (packagePurchase.sessionsRemaining <= 0) packagePurchase.status = 'fully_used';
      await packagePurchase.save();

      booking.status = 'confirmed';
      await booking.save();

      await notifyConfirmed();
      return { success: true, data: { booking } };
    }

    // ── Direct charge path ───────────────────────────────────────────────────
    const providerCustomerId = await this.ensureProviderCustomerId(buyerId);
    const charge = await this.gateway.chargeOneTime(String(booking._id), price, { providerCustomerId, idempotencyKey });

    if (!charge.success) {
      // Release the slot — a failed charge must not hold a phantom pending booking.
      await this.bookingModel.deleteOne({ _id: booking._id });
      throw new BadRequestException(`Payment failed: ${charge.failureReason ?? 'declined by payment provider'}`);
    }

    booking.status = 'confirmed';
    booking.providerChargeId = charge.providerChargeId;
    await booking.save();

    await this.financeService.recordBookingRevenue(
      service.storeId, service.sellerId, price, String(booking._id), 'booking',
      `Booking revenue — "${service.name}" on ${date.toDateString()}`,
    );

    await notifyConfirmed();
    return { success: true, data: { booking } };
  }

  async purchasePackage(buyerId: string, packageId: string, idempotencyKey?: string) {
    const pkg = await this.packageModel.findOne({ _id: packageId, status: 'active' });
    if (!pkg) throw new NotFoundException('Package not found or inactive');

    const service = await this.serviceModel.findById(pkg.serviceId);
    if (!service || service.isDelete) throw new NotFoundException('Service not found');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + pkg.validityDays * 24 * 60 * 60 * 1000);

    // Created up front so a failed charge below can simply be deleted — same
    // "create pending, delete on failure" pattern used for direct bookings.
    const purchase = await this.purchaseModel.create({
      packageId: pkg._id.toString(),
      serviceId: pkg.serviceId,
      sellerId: pkg.sellerId,
      storeId: pkg.storeId,
      buyerId,
      sessionsTotal: pkg.sessionsCount,
      sessionsRemaining: pkg.sessionsCount,
      purchasedAt: now,
      expiresAt,
      amountPaid: pkg.price,
      currency: pkg.currency,
      paymentProvider: this.gateway.providerName,
      providerChargeId: null,
      status: 'active',
    });

    const providerCustomerId = await this.ensureProviderCustomerId(buyerId);
    const charge = await this.gateway.chargeOneTime(String(purchase._id), pkg.price, { providerCustomerId, idempotencyKey });

    if (!charge.success) {
      await this.purchaseModel.deleteOne({ _id: purchase._id });
      throw new BadRequestException(`Payment failed: ${charge.failureReason ?? 'declined by payment provider'}`);
    }

    purchase.providerChargeId = charge.providerChargeId;
    await purchase.save();

    await this.financeService.recordBookingRevenue(
      pkg.storeId, pkg.sellerId, pkg.price, String(purchase._id), 'package_purchase',
      `Package purchase revenue — "${pkg.name}"`,
    );

    this.notificationsService.notify({
      recipientId: buyerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.PACKAGE_PURCHASED,
      title: 'Package purchased',
      body: `You purchased "${pkg.name}" (${pkg.sessionsCount} session${pkg.sessionsCount === 1 ? '' : 's'}).`,
      data: { packagePurchaseId: String(purchase._id) },
    }).catch(() => {});

    return { success: true, data: { purchase } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — MY BOOKINGS / MY PACKAGES
  // ═══════════════════════════════════════════════════════════════════════════

  private async verifyMyBooking(buyerId: string, id: string) {
    const booking = await this.bookingModel.findOne({ _id: id, buyerId });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async listMyBookings(buyerId: string, query: any) {
    const page  = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { buyerId };
    if (query.status) filter.status = query.status;

    const [bookings, total] = await Promise.all([
      this.bookingModel.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.bookingModel.countDocuments(filter),
    ]);

    const serviceIds = [...new Set(bookings.map((b: any) => b.serviceId))];
    const services = await this.serviceModel.find({ _id: { $in: serviceIds } }).select('name images storeId').lean();
    const serviceMap = Object.fromEntries(services.map((s: any) => [s._id.toString(), s]));

    const rows = bookings.map((b: any) => ({ ...b, service: serviceMap[b.serviceId] ?? null }));
    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, bookings: rows } };
  }

  async getMyBookingById(buyerId: string, id: string) {
    const booking = await this.verifyMyBooking(buyerId, id);
    const service = await this.serviceModel.findById(booking.serviceId).lean();
    return { success: true, data: { ...booking.toObject(), service: service ?? null } };
  }

  async cancelMyBooking(buyerId: string, id: string, reason?: string) {
    const booking = await this.verifyMyBooking(buyerId, id);
    if (!['pending_payment', 'confirmed'].includes(booking.status)) {
      throw new BadRequestException(`Cannot cancel a booking with status "${booking.status}"`);
    }

    const service = await this.serviceModel.findById(booking.serviceId).lean();
    if (service) this.assertWithinCancellationWindow(booking, (service as any).cancellationWindowHours ?? 24);

    await this.releaseBookingSlot(booking, 'cancelled_by_buyer', reason);
    return { success: true, message: 'Booking cancelled', data: booking };
  }

  async rescheduleMyBooking(buyerId: string, id: string, dto: RescheduleBookingDto) {
    const booking = await this.verifyMyBooking(buyerId, id);
    if (booking.status !== 'confirmed') {
      throw new BadRequestException(`Cannot reschedule a booking with status "${booking.status}"`);
    }

    const service = await this.serviceModel.findById(booking.serviceId);
    if (!service) throw new NotFoundException('Service not found');
    this.assertWithinCancellationWindow(booking, service.cancellationWindowHours ?? 24);

    const date = new Date(dto.date);
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    const slot = await this.findAvailableSlot(booking.serviceId, service.durationMinutes, service.capacityPerSlot, date, dto.startTime, String(booking._id));
    if (!slot) throw new BadRequestException('This time slot is not available');

    booking.date = date;
    booking.startTime = dto.startTime;
    booking.endTime = slot.endTime;
    booking.reminderSentAt = null;

    try {
      await booking.save();
    } catch (err: any) {
      if (err?.code === 11000) throw new ConflictException('You already have a booking for this time slot');
      throw err;
    }

    this.notificationsService.notify({
      recipientId: buyerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.BOOKING_RESCHEDULED,
      title: 'Booking rescheduled',
      body: `Your booking for "${service.name}" was moved to ${date.toDateString()} at ${dto.startTime}.`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});

    return { success: true, message: 'Booking rescheduled', data: booking };
  }

  async listMyPackages(buyerId: string) {
    const purchases = await this.purchaseModel.find({ buyerId }).sort({ createdAt: -1 }).lean();
    const serviceIds = [...new Set(purchases.map((p: any) => p.serviceId))];
    const services = await this.serviceModel.find({ _id: { $in: serviceIds } }).select('name images').lean();
    const serviceMap = Object.fromEntries(services.map((s: any) => [s._id.toString(), s]));

    const rows = purchases.map((p: any) => ({ ...p, service: serviceMap[p.serviceId] ?? null }));
    return { success: true, data: rows };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — BOOKINGS (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  private async verifySellerBooking(sellerId: string, storeId: string, id: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const booking = await this.bookingModel.findOne({ _id: id, storeId });
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async listSellerBookings(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const page  = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { storeId };
    if (query.status) filter.status = query.status;
    if (query.serviceId) filter.serviceId = query.serviceId;
    if (query.date) {
      const { dayStart, dayEnd } = this.dayBounds(new Date(query.date));
      filter.date = { $gte: dayStart, $lte: dayEnd };
    }

    const [bookings, total] = await Promise.all([
      this.bookingModel.find(filter).sort({ date: -1, startTime: -1 }).skip(skip).limit(limit).lean(),
      this.bookingModel.countDocuments(filter),
    ]);

    const buyerIds = [...new Set(bookings.map((b: any) => b.buyerId))];
    const buyers = await this.db.repositories.userModel.find({ _id: { $in: buyerIds } }).select('name email profileImage').lean();
    const buyerMap = Object.fromEntries(buyers.map((u: any) => [u._id.toString(), u]));

    const rows = bookings.map((b: any) => ({ ...b, buyer: buyerMap[b.buyerId] ?? { name: 'Unknown', email: 'N/A' } }));
    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, bookings: rows } };
  }

  async getSellerBookingById(sellerId: string, storeId: string, id: string) {
    const booking = await this.verifySellerBooking(sellerId, storeId, id);
    const [service, buyer] = await Promise.all([
      this.serviceModel.findById(booking.serviceId).lean(),
      this.db.repositories.userModel.findById(booking.buyerId).select('name email phone profileImage').lean(),
    ]);
    return { success: true, data: { ...booking.toObject(), service: service ?? null, buyer: buyer ?? null } };
  }

  async confirmBooking(sellerId: string, storeId: string, id: string) {
    const booking = await this.verifySellerBooking(sellerId, storeId, id);
    if (booking.status !== 'pending_payment') {
      throw new BadRequestException(`Cannot confirm a booking with status "${booking.status}"`);
    }
    booking.status = 'confirmed';
    await booking.save();
    return { success: true, message: 'Booking confirmed', data: booking };
  }

  async completeBooking(sellerId: string, storeId: string, id: string) {
    const booking = await this.verifySellerBooking(sellerId, storeId, id);
    if (booking.status !== 'confirmed') {
      throw new BadRequestException(`Cannot complete a booking with status "${booking.status}"`);
    }
    booking.status = 'completed';
    await booking.save();
    return { success: true, message: 'Booking marked completed', data: booking };
  }

  async sellerCancelBooking(sellerId: string, storeId: string, id: string, reason?: string) {
    const booking = await this.verifySellerBooking(sellerId, storeId, id);
    if (!['pending_payment', 'confirmed'].includes(booking.status)) {
      throw new BadRequestException(`Cannot cancel a booking with status "${booking.status}"`);
    }

    await this.releaseBookingSlot(booking, 'cancelled_by_seller', reason);

    this.notificationsService.notify({
      recipientId: booking.buyerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.BOOKING_CANCELLED,
      title: 'Booking cancelled',
      body: `Your booking on ${new Date(booking.date).toDateString()} at ${booking.startTime} was cancelled by the seller${reason ? ` (${reason})` : ''}.`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});

    return { success: true, message: 'Booking cancelled', data: booking };
  }

  async sellerRescheduleBooking(sellerId: string, storeId: string, id: string, dto: RescheduleBookingDto) {
    const booking = await this.verifySellerBooking(sellerId, storeId, id);
    if (!['pending_payment', 'confirmed'].includes(booking.status)) {
      throw new BadRequestException(`Cannot reschedule a booking with status "${booking.status}"`);
    }

    const service = await this.serviceModel.findById(booking.serviceId);
    if (!service) throw new NotFoundException('Service not found');

    const date = new Date(dto.date);
    if (isNaN(date.getTime())) throw new BadRequestException('Invalid date');

    const slot = await this.findAvailableSlot(booking.serviceId, service.durationMinutes, service.capacityPerSlot, date, dto.startTime, String(booking._id));
    if (!slot) throw new BadRequestException('This time slot is not available');

    booking.date = date;
    booking.startTime = dto.startTime;
    booking.endTime = slot.endTime;
    booking.reminderSentAt = null;
    await booking.save();

    this.notificationsService.notify({
      recipientId: booking.buyerId,
      recipientRole: 'user',
      type: NOTIFICATION_TYPES.BOOKING_RESCHEDULED,
      title: 'Booking rescheduled',
      body: `Your booking was moved to ${date.toDateString()} at ${dto.startTime} by the seller.`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});

    return { success: true, message: 'Booking rescheduled', data: booking };
  }

  async setMeetingLink(sellerId: string, storeId: string, id: string, meetingLink: string) {
    const booking = await this.verifySellerBooking(sellerId, storeId, id);
    if (booking.locationType !== 'virtual') {
      throw new BadRequestException('A meeting link only applies to "virtual" bookings');
    }
    booking.meetingLink = meetingLink;
    await booking.save();
    return { success: true, data: booking };
  }

  async getSellerDashboard(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const now = new Date();
    const { dayStart: todayStart, dayEnd: todayEnd } = this.dayBounds(now);
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [todayCount, upcomingCount, completedThisMonth, cancelledThisMonth, revenueAgg, statusBreakdown] = await Promise.all([
      this.bookingModel.countDocuments({ storeId, date: { $gte: todayStart, $lte: todayEnd }, status: { $in: ['pending_payment', 'confirmed'] } }),
      this.bookingModel.countDocuments({ storeId, date: { $gt: todayEnd }, status: 'confirmed' }),
      this.bookingModel.countDocuments({ storeId, status: 'completed', updatedAt: { $gte: thisMonthStart } }),
      this.bookingModel.countDocuments({ storeId, status: { $in: ['cancelled_by_buyer', 'cancelled_by_seller'] }, updatedAt: { $gte: thisMonthStart } }),
      this.bookingModel.aggregate([
        { $match: { storeId, status: { $in: ['confirmed', 'completed'] }, createdAt: { $gte: thisMonthStart } } },
        { $group: { _id: null, total: { $sum: '$price' } } },
      ]),
      this.bookingModel.aggregate([
        { $match: { storeId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    return {
      success: true,
      data: {
        todayCount,
        upcomingCount,
        completedThisMonth,
        cancelledThisMonth,
        revenueThisMonthUSD: this.round(revenueAgg[0]?.total ?? 0),
        statusBreakdown: statusBreakdown.map((r: any) => ({ status: r._id, count: r.count })),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULER HOOKS (invoked by SchedulerService's @Cron jobs)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Flips 'confirmed' bookings whose date+endTime has already passed to 'completed'. */
  async completePastBookings(): Promise<{ completed: number }> {
    const now = new Date();
    // Narrowed to date <= now to keep the candidate set small — a booking's
    // endTime is always same-day as `date` in this schema.
    const candidates = await this.bookingModel.find({ status: 'confirmed', date: { $lte: now } }).select('date endTime').lean();

    const idsToComplete: string[] = [];
    for (const b of candidates as any[]) {
      const [h, m] = b.endTime.split(':').map((n: string) => parseInt(n, 10));
      const end = new Date(b.date);
      end.setHours(h, m, 0, 0);
      if (end.getTime() <= now.getTime()) idsToComplete.push(b._id.toString());
    }

    if (idsToComplete.length === 0) return { completed: 0 };
    await this.bookingModel.updateMany({ _id: { $in: idsToComplete } }, { $set: { status: 'completed' } });
    return { completed: idsToComplete.length };
  }

  /** Mirrors expireLoyaltyPoints' daily style — marks past-expiry active package purchases as 'expired'. */
  async expirePackagePurchases(): Promise<{ expired: number }> {
    const result = await this.purchaseModel.updateMany(
      { status: 'active', expiresAt: { $lt: new Date() } },
      { $set: { status: 'expired' } },
    );
    return { expired: result.modifiedCount ?? 0 };
  }

  /** Mirrors sendSubscriptionReminders — notifies buyers with a confirmed booking in the next ~24h, deduped via `reminderSentAt`. */
  async sendBookingReminders(): Promise<{ sent: number }> {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const candidates = await this.bookingModel.find({
      status: 'confirmed',
      reminderSentAt: null,
      date: { $gte: now, $lte: in24h },
    }).lean();

    let sent = 0;
    for (const b of candidates as any[]) {
      const service = await this.serviceModel.findById(b.serviceId).select('name').lean();
      // eslint-disable-next-line no-await-in-loop
      await this.notificationsService.notify({
        recipientId: b.buyerId,
        recipientRole: 'user',
        type: NOTIFICATION_TYPES.BOOKING_REMINDER,
        title: 'Upcoming booking reminder',
        body: `Reminder: your booking for "${(service as any)?.name ?? 'your service'}" is on ${new Date(b.date).toDateString()} at ${b.startTime}.`,
        data: { bookingId: b._id.toString() },
      }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await this.bookingModel.updateOne({ _id: b._id }, { $set: { reminderSentAt: new Date() } });
      sent++;
    }

    return { sent };
  }
}
