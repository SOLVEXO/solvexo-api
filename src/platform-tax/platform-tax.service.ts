/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';
import { fromStripeAmount } from '../common/stripe-amount.util';
import { PlatformTaxRecord, PlatformTaxRecordDocument } from './schemas/platform-tax-record.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { resolveStoreCountry } from '../integrations/payment-availability.util';
import { PlatformTaxSettings, PlatformTaxSettingsDocument } from './schemas/platform-tax-settings.schema';
import { isValidTaxId, pickPlatformTaxRate, PlatformTaxPick, PlatformTaxRate, round2, taxOnNet } from './platform-tax.util';
import { UpdatePlatformTaxDto } from './dto/update-platform-tax.dto';

const KEY = 'platform';
const EMPTY = { key: KEY, legalName: '', ntn: '', strn: '', authority: 'FBR', address: '', rates: [] as any[] };

@Injectable()
export class PlatformTaxService {
  private readonly logger = new Logger(PlatformTaxService.name);

  constructor(
    @InjectModel(PlatformTaxSettings.name) private readonly model: Model<PlatformTaxSettingsDocument>,
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly activityLogService: ActivityLogService,
    @Optional() @InjectModel(PlatformTaxRecord.name) private readonly recordModel?: Model<PlatformTaxRecordDocument>,
    @Optional() private readonly exchangeRate?: ExchangeRateService,
  ) {}

  /** Remembers the tax collected on a paid one-off charge (promotion, store-app fee, POS plan). Idempotent per charge; never throws (billing must not fail over a report row). */
  async recordCollected(p: { source: 'promotion' | 'store_app' | 'pos_plan'; refId: string; storeId: string; taxMinor: number; currency: string }): Promise<void> {
    try {
      if (!this.recordModel || !(p.taxMinor > 0) || !p.refId) return;
      const cur = String(p.currency || 'USD').toUpperCase();
      const major = fromStripeAmount(p.taxMinor, cur);
      const usd = cur === 'USD' ? major : await this.exchangeRate?.convert(major, cur, 'USD');
      if (typeof usd !== 'number' || !Number.isFinite(usd)) {
        this.logger.warn(`Platform tax record skipped for ${p.source} ${p.refId}: no ${cur}->USD rate`);
        return;
      }
      await this.recordModel.updateOne(
        { source: p.source, refId: p.refId },
        { $setOnInsert: { source: p.source, refId: p.refId, storeId: p.storeId, taxAmountUSD: round2(usd), collectedAt: new Date() } },
        { upsert: true },
      );
    } catch (e) {
      this.logger.error(`Could not record platform tax for ${p.source} ${p.refId}: ${(e as Error).message}`);
    }
  }

  /** Tax (USD) collected on promotions, store-app fees and POS plans in a date range. */
  async collectedTaxUSD(from: Date, to: Date): Promise<number> {
    if (!this.recordModel) return 0;
    const rows: any[] = await this.recordModel.aggregate([
      { $match: { collectedAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, total: { $sum: '$taxAmountUSD' } } },
    ]);
    return round2(rows[0]?.total ?? 0);
  }

  async getSettings() {
    const doc = await this.model.findOne({ key: KEY }).lean();
    return doc ?? { ...EMPTY };
  }

  async update(dto: UpdatePlatformTaxDto, adminId: string) {
    const current: any = await this.getSettings();
    const set: Record<string, any> = { updatedBy: adminId };

    for (const f of ['ntn', 'strn'] as const) {
      if (dto[f] === undefined) continue;
      const v = dto[f]!.trim();
      if (v && !isValidTaxId(v)) throw new BadRequestException(`${f.toUpperCase()} may contain letters, digits, spaces, "-", "." and "/" only (max 30).`);
      set[f] = v;
    }
    if (dto.legalName !== undefined) set.legalName = dto.legalName.trim();
    if (dto.authority !== undefined) set.authority = dto.authority;
    if (dto.address !== undefined) set.address = dto.address.trim();

    if (dto.rates) {
      const old = new Map<string, any>((current.rates ?? []).map((r: any) => [r.id, r]));
      const seen = new Set<string>();
      set.rates = dto.rates.map((r) => {
        const country = r.country.toUpperCase();
        const label = r.label.trim() || 'Sales Tax';
        const id = r.id && !seen.has(r.id) ? r.id : randomUUID();
        seen.add(id);
        const prev = old.get(id);
        // A Stripe TaxRate cannot be edited: keep its id only while percentage/label/country are unchanged.
        const sameAsPrev = prev && prev.ratePercent === r.ratePercent && prev.label === label && prev.country === country;
        return {
          id, country, label, ratePercent: r.ratePercent, status: r.status,
          effectiveFrom: r.effectiveFrom ? new Date(r.effectiveFrom) : null,
          stripeTaxRateId: sameAsPrev ? prev.stripeTaxRateId ?? null : null,
        };
      });
      const confirmedKeys = new Set<string>();
      for (const r of set.rates) {
        if (r.status !== 'confirmed') continue;
        const k = `${r.country}|${r.effectiveFrom ? r.effectiveFrom.toISOString() : ''}`;
        if (confirmedKeys.has(k)) throw new BadRequestException(`Two confirmed rates for ${r.country} start on the same date. Change one of them.`);
        confirmedKeys.add(k);
      }
    }

    await this.model.updateOne({ key: KEY }, { $set: set, $setOnInsert: { key: KEY } }, { upsert: true });
    this.activityLogService.log({
      category: 'platform_plans', action: 'platform_tax_updated',
      description: 'Solvexo platform tax settings updated', actorId: adminId, actorRole: 'admin',
    });
    return this.getSettings();
  }

  /** Which tax (if any) applies to a plan fee charged to this store's seller, from the store country. Never throws. */
  async resolveForStore(storeId: string, at: Date = new Date()): Promise<PlatformTaxPick & { country: string | null }> {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('country baseCurrency').lean();
    const country = store ? resolveStoreCountry(store) : null;
    const settings: any = await this.getSettings();
    return { ...pickPlatformTaxRate(settings.rates as PlatformTaxRate[], country, at), country };
  }

  /** Tax on a net amount charged to this store's seller (add-ons, fees...), or none. Never throws. */
  async quoteForStore(storeId: string, netUSD: number): Promise<{ netUSD: number; taxUSD: number; totalUSD: number; ratePercent: number; label: string | null; country: string | null }> {
    try {
      const picked = await this.resolveForStore(storeId);
      if (!picked.rate) return { netUSD, taxUSD: 0, totalUSD: netUSD, ratePercent: 0, label: null, country: picked.country };
      const { taxUSD, totalUSD } = taxOnNet(netUSD, picked.rate.ratePercent);
      return { netUSD, taxUSD, totalUSD, ratePercent: picked.rate.ratePercent, label: picked.rate.label, country: picked.country };
    } catch (e) {
      this.logger.error(`Could not quote platform tax for store ${storeId}: ${(e as Error).message}`);
      return { netUSD, taxUSD: 0, totalUSD: netUSD, ratePercent: 0, label: null, country: null };
    }
  }

  /** Tax percentage + label that applies to this store's seller, or null. For charges made in the store's own currency (promotions, app fees), where the tax is taken as a % of the amount. Never throws. */
  async rateForStore(storeId: string): Promise<{ ratePercent: number; label: string; country: string | null } | null> {
    try {
      const picked = await this.resolveForStore(storeId);
      return picked.rate ? { ratePercent: picked.rate.ratePercent, label: picked.rate.label, country: picked.country } : null;
    } catch (e) {
      this.logger.error(`Could not resolve platform tax rate for store ${storeId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Countries of sellers who pay Solvexo today but have NO usable tax rate, so the admin can see what is not being taxed. */
  async coverageGaps() {
    const subs: any[] = await this.db.repositories.sellerPlatformSubscriptionModel
      .find({ isDelete: false, status: { $in: ['active', 'past_due'] }, amountUSD: { $gt: 0 } }).select('storeId').limit(10000).lean();
    const ids = [...new Set(subs.map((s) => String(s.storeId)))];
    const stores: any[] = ids.length ? await this.db.repositories.storeModel.find({ _id: { $in: ids } }).select('country baseCurrency').lean() : [];
    const settings: any = await this.getSettings();
    const byCountry = new Map<string, number>();
    for (const st of stores) {
      const cc = resolveStoreCountry(st) ?? 'UNKNOWN';
      byCountry.set(cc, (byCountry.get(cc) ?? 0) + 1);
    }
    const gaps: Array<{ country: string; stores: number; reason: string }> = [];
    for (const [country, count] of byCountry) {
      const pick = country === 'UNKNOWN' ? { rate: null, reason: 'no_country' } : pickPlatformTaxRate(settings.rates as PlatformTaxRate[], country);
      if (!pick.rate && pick.reason !== 'zero') gaps.push({ country, stores: count, reason: pick.reason });
    }
    return gaps.sort((a, b) => b.stores - a.stores);
  }

  /** Stripe TaxRate id to attach to this store's plan subscription, or null when no tax applies / Stripe can't create it. Never throws (a tax setup problem must not block a sale). */
  async taxRateIdForStore(storeId: string): Promise<string | null> {
    try {
      const picked = await this.resolveForStore(storeId);
      if (!picked.rate) return null;
      const id = await this.gateway.getOrCreateTaxRate({
        percentage: picked.rate.ratePercent, label: picked.rate.label, country: picked.country!,
        existingId: picked.rate.stripeTaxRateId ?? null,
      });
      if (id && id !== picked.rate.stripeTaxRateId) {
        await this.model.updateOne({ key: KEY, 'rates.id': picked.rate.id }, { $set: { 'rates.$.stripeTaxRateId': id } });
      }
      return id;
    } catch (e) {
      this.logger.error(`Could not prepare platform tax rate for store ${storeId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Brings every live Stripe plan subscription in line with the rate table (add / change / remove its tax rate from the next invoice). */
  async applyToExistingSubscriptions(dryRun: boolean, adminId: string) {
    const subs: any[] = await this.db.repositories.sellerPlatformSubscriptionModel
      .find({ isDelete: false, providerSubscriptionId: { $ne: null }, paymentProvider: 'stripe', status: { $in: ['active', 'trialing', 'past_due'] } })
      .select('storeId providerSubscriptionId').limit(5000).lean();
    const out = { total: subs.length, withTax: 0, withoutTax: 0, failed: 0, dryRun };
    const cache = new Map<string, string | null>();
    for (const s of subs) {
      try {
        const picked = await this.resolveForStore(s.storeId);
        const ck = picked.rate ? `${picked.country}|${picked.rate.id}` : '-';
        let taxRateId: string | null | undefined = cache.get(ck);
        if (taxRateId === undefined) { taxRateId = dryRun ? (picked.rate ? 'x' : null) : await this.taxRateIdForStore(s.storeId); cache.set(ck, taxRateId); }
        if (taxRateId) out.withTax++; else out.withoutTax++;
        if (!dryRun) await this.gateway.setSubscriptionTaxRate(s.providerSubscriptionId, taxRateId);
      } catch (e) {
        out.failed++;
        this.logger.error(`apply platform tax failed for sub ${s.providerSubscriptionId}: ${(e as Error).message}`);
      }
    }
    if (!dryRun) {
      this.activityLogService.log({
        category: 'platform_plans', action: 'platform_tax_applied_to_subscriptions',
        description: `Platform tax applied to ${out.withTax} subscriptions (${out.withoutTax} without tax, ${out.failed} failed)`,
        actorId: adminId, actorRole: 'admin',
      });
    }
    return out;
  }
}
