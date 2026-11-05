/* eslint-disable prettier/prettier */
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { CourierService, CourierConnection } from '@/integrations/couriers/courier.service';
import { COURIER_CATALOG } from '@/integrations/couriers/courier-catalog';
import { canAdvanceCourierStatus, CourierError, CourierKey, CourierTrackResult } from '@/integrations/couriers/courier.types';
import { OrdersService } from './orders.service';

const SYNC_INTERVAL_MS = 15 * 60_000;
const MAX_FAILURES = 20;
const BATCH_CAP = 500;

/**
 * Pulls tracking for every live courier booking and applies it to the order through the EXISTING transition code:
 *  - delivered  -> OrdersService.markShipmentDelivered (the normal delivered path: status, buyer email/WhatsApp), once.
 *  - returned   -> seller-visible RTO flag + timeline + seller notification ONLY. No stock, refund or money change.
 *  - COD info   -> stored read-only on the booking.
 * Every step is idempotent (event hashes, conditional updates, a one-shot `deliveredAppliedAt` claim) and
 * out-of-order statuses are ignored (canAdvanceCourierStatus).
 */
@Injectable()
export class CourierTrackingSyncService {
  private readonly logger = new Logger(CourierTrackingSyncService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly courier: CourierService,
    private readonly ordersService: OrdersService,
    private readonly notificationsService: NotificationsService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() { return this.databaseService.repositories.courierBookingModel; }

  /** Cron entry point. Returns counts for logging. */
  async syncDueBookings(now = new Date()): Promise<{ checked: number; updated: number; failed: number }> {
    const dueBefore = new Date(now.getTime() - SYNC_INTERVAL_MS);
    const rows: any[] = await this.model
      .find({
        isActive: true, bookingStatus: { $in: ['booked', 'fulfil_failed'] }, trackingNumber: { $ne: null }, syncFailures: { $lt: MAX_FAILURES },
        $and: [
          { $or: [{ courierStatus: null }, { courierStatus: { $nin: ['delivered', 'returned', 'cancelled'] } }, { courierStatus: 'delivered', deliveredAppliedAt: null, bookingStatus: 'booked' }] },
          { $or: [{ lastSyncedAt: null }, { lastSyncedAt: { $lte: dueBefore } }] },
        ],
      })
      .sort({ lastSyncedAt: 1 }).limit(BATCH_CAP).lean();

    // Failure back-off: a booking that keeps failing is retried less and less often (5m * 2^n, capped at 6h).
    const eligible = rows.filter((r) => {
      if (!r.syncFailures || !r.lastSyncedAt) return true;
      const wait = Math.min(6 * 3600_000, 5 * 60_000 * 2 ** r.syncFailures);
      return now.getTime() - new Date(r.lastSyncedAt).getTime() >= wait;
    });

    const groups = new Map<string, any[]>();
    for (const r of eligible) {
      const k = `${r.storeId}|${r.provider}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }

    let updated = 0; let failed = 0;
    for (const [, bookings] of groups) {
      const { storeId, provider } = bookings[0];
      let conn: CourierConnection;
      try {
        conn = await this.courier.resolveConnection(storeId, provider);
      } catch (err: any) {
        await this.recordFailure(bookings.map((b) => String(b._id)), err?.message ?? 'Courier not usable');
        failed += bookings.length;
        continue;
      }
      const size = Math.max(1, conn.provider.capabilities.trackBatchSize);
      for (let i = 0; i < bookings.length; i += size) {
        const chunk = bookings.slice(i, i + size);
        let results: CourierTrackResult[];
        try {
          results = await this.courier.trackAtCourier(conn, chunk.map((b) => b.trackingNumber));
        } catch (err: any) {
          await this.recordFailure(chunk.map((b) => String(b._id)), err instanceof CourierError ? err.message : 'Tracking failed');
          failed += chunk.length;
          continue;
        }
        const byTn = new Map(results.map((r) => [r.trackingNumber, r]));
        for (const b of chunk) {
          const res = byTn.get(b.trackingNumber);
          if (!res) { await this.recordFailure([String(b._id)], 'Courier returned no tracking for this parcel'); failed++; continue; }
          try {
            if (await this.applyTrackResult(String(b._id), res, now)) updated++;
          } catch (err: any) {
            this.logger.warn(`Courier sync apply failed for booking ${b._id}: ${err?.message ?? err}`);
            await this.recordFailure([String(b._id)], 'Could not apply the courier update');
            failed++;
          }
        }
      }
    }
    return { checked: eligible.length, updated, failed };
  }

  private async recordFailure(ids: string[], message: string) {
    await this.model.updateMany({ _id: { $in: ids } }, { $inc: { syncFailures: 1 }, $set: { lastSyncError: message.slice(0, 200), lastSyncedAt: new Date() } });
  }

  /**
   * Applies one courier tracking result to a booking (shared by the sync job and any future push webhook).
   * Returns true when the booking's status/events changed.
   */
  async applyTrackResult(bookingId: string, result: CourierTrackResult, now = new Date()): Promise<boolean> {
    const booking: any = await this.model.findById(bookingId);
    if (!booking || !booking.isActive) return false;
    let changed = false;

    // 1. Events — append only ones we have not stored (hash), oldest first.
    const have = new Set((booking.events ?? []).map((e: any) => e.hash));
    const fresh = [...result.events]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .map((e) => ({ ...e, hash: CourierService.eventHash(e.status, e.rawStatus, e.occurredAt) }))
      .filter((e) => !have.has(e.hash))
      .map((e) => ({ status: e.status, rawStatus: e.rawStatus, description: e.description ?? null, location: e.location ?? null, occurredAt: e.occurredAt, hash: e.hash }));
    if (fresh.length) {
      await this.model.updateOne({ _id: bookingId, 'events.hash': { $nin: fresh.map((e) => e.hash) } }, { $push: { events: { $each: fresh } } });
      changed = true;
    }

    // 2. Status — only forward (or RTO/cancel), claimed atomically against the status we read.
    const next = result.status;
    const common = { lastSyncedAt: now, syncFailures: 0, lastSyncError: null, ...(result.cod ? { cod: result.cod } : {}) };
    if (canAdvanceCourierStatus(booking.courierStatus, next) && booking.courierStatus !== next) {
      const claimed = await this.model.findOneAndUpdate(
        { _id: bookingId, courierStatus: booking.courierStatus },
        { $set: { courierStatus: next, rawStatus: result.rawStatus, ...common } },
        { new: true },
      );
      if (!claimed) return changed; // another worker advanced it first
      changed = true;
      await this.onStatusChanged(claimed, next);
    } else {
      await this.model.updateOne({ _id: bookingId }, { $set: common });
    }

    // 3. Delivered side effect must also be retried when a previous attempt failed (booking already says delivered).
    const cur: any = await this.model.findById(bookingId);
    if (cur.courierStatus === 'delivered' && !cur.deliveredAppliedAt && cur.bookingStatus === 'booked') await this.applyDelivered(cur);
    return changed;
  }

  private async onStatusChanged(b: any, next: string) {
    const label = COURIER_CATALOG[b.provider as CourierKey]?.label ?? b.provider;
    if (next === 'returned') await this.applyReturned(b, label);
    else if (next === 'cancelled') {
      await this.model.updateOne({ _id: b._id }, { $set: { bookingStatus: 'cancelled', isActive: false, cancelledAt: new Date() } });
      await this.timeline(b.orderId, `${label} reports booking ${b.trackingNumber} as cancelled — book again to ship it`);
    }
  }

  /** Delivered, exactly once: a one-shot claim guards the existing delivered path from running twice. */
  private async applyDelivered(b: any) {
    if (!b.shipmentId) {
      await this.model.updateOne({ _id: b._id }, { $set: { lastSyncError: 'Delivered at the courier, but the booking is not linked to a shipment — mark it delivered manually' } });
      return;
    }
    const claim = await this.model.findOneAndUpdate({ _id: b._id, deliveredAppliedAt: null }, { $set: { deliveredAppliedAt: new Date() } });
    if (!claim) return;
    try {
      await this.ordersService.markShipmentDelivered(b.sellerId, b.storeId, b.orderId, b.shipmentId);
    } catch (err: any) {
      // A 4xx (order cancelled/refunded, shipment gone) is permanent — keep the claim so we never retry forever.
      // Anything else (DB blip) releases it so the next sync tries again.
      if (!(err instanceof HttpException) || err.getStatus() >= 500) {
        await this.model.updateOne({ _id: b._id }, { $set: { deliveredAppliedAt: null, lastSyncError: 'Could not mark the order delivered yet — will retry' } });
      } else {
        await this.model.updateOne({ _id: b._id }, { $set: { lastSyncError: String(err.message).slice(0, 200) } });
      }
    }
  }

  /** RTO: flag + timeline + seller notification. Deliberately NO stock / refund / money change. */
  private async applyReturned(b: any, label: string) {
    const claim = await this.model.findOneAndUpdate({ _id: b._id, rtoNotifiedAt: null }, { $set: { rto: true, rtoAt: new Date(), rtoNotifiedAt: new Date() } });
    if (!claim) return;
    await this.timeline(b.orderId, `${label} reports parcel ${b.trackingNumber} is returning to origin (RTO) — review the order; stock and refunds are NOT changed automatically`);
    this.notificationsService.notify({
      recipientId: b.sellerId, recipientRole: 'seller', storeId: b.storeId, type: NOTIFICATION_TYPES.ORDER_COURIER_RTO,
      title: 'Parcel returning to origin (RTO)', body: `${label} parcel ${b.trackingNumber} is being returned to you.`, data: { orderId: b.orderId, bookingId: String(b._id) },
    }).catch(() => {});
    this.activityLogService.log({
      storeId: b.storeId, category: 'orders', action: 'courier_rto', description: `Courier parcel ${b.trackingNumber} flagged as returned (RTO)`,
      actorId: null as any, actorRole: 'system' as any, targetId: b.orderId, targetType: 'order', metadata: { provider: b.provider },
    });
  }

  private async timeline(orderId: string, message: string) {
    try {
      await this.databaseService.repositories.orderModel.updateOne(
        { _id: orderId }, { $push: { timeline: { type: 'status', message, actorId: null, actorRole: 'system', createdAt: new Date() } } },
      );
    } catch { /* informational */ }
  }
}
