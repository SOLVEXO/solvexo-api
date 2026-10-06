/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { syncStorePlanCache } from './store-plan-sync.util';

/**
 * Boot-time, READ-MOSTLY reconciliation after retiring the legacy `platform-subscriptions` system.
 *  1. Logs every store that still has a legacy `PlatformSubscription` (not deleted) but NO
 *     `SellerPlatformSubscription`. It creates/charges NOTHING — a human must decide what to do with them
 *     (a paid legacy tier is no longer billed by anything).
 *  2. Re-aligns the denormalised `Store.plan` cache from SellerPlatformSubscription (idempotent conditional writes).
 * Safe on every boot / several replicas; failures never block startup.
 */
@Injectable()
export class LegacyPlatformSubscriptionBackfillService implements OnModuleInit {
  private readonly logger = new Logger(LegacyPlatformSubscriptionBackfillService.name);
  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    try {
      await this.reportOrphanedLegacySubscriptions();
      await this.syncStorePlanCaches();
    } catch (err: any) {
      this.logger.error(`Legacy platform-subscription reconciliation failed: ${err?.message}`, err?.stack);
    }
  }

  async reportOrphanedLegacySubscriptions(): Promise<Array<{ storeId: string; tier: string; status: string }>> {
    const legacy: any[] = await this.db.repositories.platformSubscriptionModel
      .find({ isDelete: { $ne: true } }).select('storeId tier status billingInterval amountUSD paymentProvider providerSubscriptionId').lean();
    if (!legacy.length) return [];
    const current: any[] = await this.db.repositories.sellerPlatformSubscriptionModel
      .find({ storeId: { $in: legacy.map((l) => l.storeId) } }).select('storeId').lean();
    const have = new Set(current.map((c) => String(c.storeId)));
    const orphans = legacy.filter((l) => !have.has(String(l.storeId)));
    if (orphans.length) {
      this.logger.warn(
        `LEGACY PLATFORM SUBSCRIPTIONS WITHOUT A SellerPlatformSubscription: ${orphans.length} store(s). ` +
        `Nothing bills these any more — review manually. ` +
        orphans.map((o) => `[storeId=${o.storeId} tier=${o.tier} status=${o.status} ${o.billingInterval} $${o.amountUSD} provider=${o.paymentProvider}${o.providerSubscriptionId ? ' stripeSub=' + o.providerSubscriptionId : ''}]`).join(' '),
      );
    }
    return orphans.map((o) => ({ storeId: String(o.storeId), tier: o.tier, status: o.status }));
  }

  async syncStorePlanCaches(): Promise<number> {
    const subs: any[] = await this.db.repositories.sellerPlatformSubscriptionModel
      .find({ isDelete: { $ne: true } }).select('storeId platformPlanId status isDelete').lean();
    let changed = 0;
    for (const sub of subs) {
      if (await syncStorePlanCache({ storeModel: this.db.repositories.storeModel, planModel: this.db.repositories.platformPlanModel }, sub)) changed++;
    }
    if (changed) this.logger.log(`Store.plan cache re-aligned from SellerPlatformSubscription for ${changed} store(s)`);
    return changed;
  }
}
