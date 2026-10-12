/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { isAnalyticsId } from '../common/storefront-session.util';
import {
  classifyTrafficSource,
  cleanPath,
  countryFromSignals,
  deviceTypeFromUserAgent,
  externalReferrerHost,
  isBotUserAgent,
} from './storefront-analytics.util';

export interface PageViewInput {
  storeId: string;
  sessionId: string;
  visitorId: string;
  path?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  timeZone?: string;
}

export interface RequestSignals {
  userAgent?: string;
  geoCountry?: string;
  userId?: string | null;
}

const STORE_CACHE_MS = 60_000;
const PLATFORM_HOST = 'solvexo.store';

/**
 * Records online-store visits (sessions) for Shopify-style Sessions / Conversion rate / Live View reports.
 * Page views come from the storefront; funnel steps are marked server-side (see common/storefront-session.util).
 */
@Injectable()
export class StorefrontAnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(StorefrontAnalyticsService.name);
  private readonly storeCache = new Map<string, { at: number; ok: boolean; hosts: string[] }>();

  constructor(private readonly databaseService: DatabaseService) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /**
   * One-off catch-up for orders converted BEFORE orders were stamped with their visit's traffic source: copies the source
   * from the converting session onto orders that have none. Idempotent (only touches orders without a source), bounded per
   * boot, never blocks startup.
   */
  onModuleInit() {
    void this.backfillOrderTrafficSource().catch((err) => this.logger.warn(`Traffic-source backfill skipped: ${err?.message ?? err}`));
  }

  async backfillOrderTrafficSource(limit = 5000): Promise<number> {
    const sessions: any[] = await this.r.storefrontSessionModel
      .find({ converted: true, 'orderIds.0': { $exists: true } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .select('orderIds trafficSource')
      .lean();
    const ops = sessions
      .filter((s) => s.trafficSource && s.orderIds?.length)
      .map((s) => ({
        updateMany: {
          filter: { _id: { $in: s.orderIds }, trafficSource: null },
          update: { $set: { trafficSource: s.trafficSource } },
        },
      }));
    if (ops.length === 0) return 0;
    const res: any = await this.r.orderModel.bulkWrite(ops as any, { ordered: false });
    const updated = res?.modifiedCount ?? 0;
    if (updated > 0) this.logger.log(`Traffic-source backfill: stamped ${updated} order(s)`);
    return updated;
  }

  /** Only live, open stores collect sessions; the store's own hosts are internal referrers. Cached for a minute. */
  private async storeInfo(storeId: string): Promise<{ ok: boolean; hosts: string[] }> {
    const hit = this.storeCache.get(storeId);
    if (hit && Date.now() - hit.at < STORE_CACHE_MS) return hit;
    const store: any = await this.r.storeModel.findById(storeId).select('slug status isDelete customDomains customDomain').lean();
    const ok = !!store && !store.isDelete && (store.status ?? 'active') === 'active';
    const hosts = [
      PLATFORM_HOST,
      ...(Array.isArray(store?.customDomains) ? store.customDomains.map((d: any) => String(d?.domain ?? '').toLowerCase()).filter(Boolean) : []),
      ...(store?.customDomain ? [String(store.customDomain).toLowerCase()] : []),
    ].map((h) => h.replace(/^www\./, ''));
    const entry = { at: Date.now(), ok, hosts };
    if (this.storeCache.size > 5000) this.storeCache.clear();
    this.storeCache.set(storeId, entry);
    return entry;
  }

  async recordPageView(input: PageViewInput, signals: RequestSignals): Promise<{ recorded: boolean }> {
    if (!isValidObjectId(input.storeId) || !isAnalyticsId(input.sessionId) || !isAnalyticsId(input.visitorId)) return { recorded: false };
    if (isBotUserAgent(signals.userAgent)) return { recorded: false };
    const store = await this.storeInfo(input.storeId);
    if (!store.ok) return { recorded: false };

    const model = this.r.storefrontSessionModel;
    const now = new Date();
    const path = cleanPath(input.path);
    const filter = { storeId: input.storeId, sessionId: input.sessionId };
    const update = {
      $set: { lastSeenAt: now, currentPath: path, ...(signals.userId ? { userId: signals.userId } : {}) },
      $inc: { pageViews: 1 },
    };

    const existing = await model.updateOne(filter, update);
    if (existing.matchedCount > 0) return { recorded: true };

    // First page of a new visit.
    const referrerHost = externalReferrerHost(input.referrer, store.hosts);
    const returningVisitor = !!(await model.exists({ storeId: input.storeId, visitorId: input.visitorId, startedAt: { $lt: now } }));
    const clip = (v?: string) => (v ? String(v).slice(0, 100) : null);
    try {
      await model.create({
        storeId: input.storeId,
        sessionId: input.sessionId,
        visitorId: input.visitorId,
        startedAt: now,
        lastSeenAt: now,
        pageViews: 1,
        landingPath: path,
        currentPath: path,
        referrerHost,
        trafficSource: classifyTrafficSource({ referrerHost, utmMedium: input.utmMedium, utmSource: input.utmSource }),
        utmSource: clip(input.utmSource),
        utmMedium: clip(input.utmMedium),
        utmCampaign: clip(input.utmCampaign),
        deviceType: deviceTypeFromUserAgent(signals.userAgent),
        country: countryFromSignals(signals.geoCountry, input.timeZone),
        returningVisitor,
        userId: signals.userId ?? null,
      });
    } catch (err: any) {
      // Two first-page beacons raced: the other one created it — count this view on it.
      if (err?.code === 11000) await model.updateOne(filter, update);
      else throw err;
    }
    return { recorded: true };
  }
}
