/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { UpdateFeatureFlagsDto } from './dto/update-feature-flags.dto';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';
import { UpdateEmailConfigDto } from './dto/update-email-config.dto';
import { UpdatePlacementLimitsDto } from './dto/update-placement-limits.dto';
import { UpdatePromotionPricingDto } from './dto/update-promotion-pricing.dto';
import { PlacementLimitKey } from '../common/promotion-placements.const';
import { UpdatePayoutConfigDto } from './dto/update-payout-config.dto';
import { UpdateManualPaymentConfigDto } from './dto/update-manual-payment-config.dto';
import { UpdateFxConfigDto } from './dto/update-fx-config.dto';
import { isRealCurrencyCode, ALL_CURRENCY_CODES } from '../common/currency-metadata.const';

export type FeatureFlagKey =
  | 'aiStudio' | 'marketplace' | 'digitalUploads' | 'affiliateProgram'
  | 'giftCards' | 'posMode' | 'storeBuilder' | 'bulkProductImport' | 'promotions'
  | 'storefrontBlog';

interface AuditMeta {
  adminId: string;
  ip?: string;
  userAgent?: string;
}

// Singleton settings document — always the same (only) row in the collection,
// fetched/created lazily via upsert so there's no separate "seed" step.
@Injectable()
export class AdminConfigService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get model() {
    return this.databaseService.repositories.platformConfigModel;
  }

  // FeatureFlagGuard and the maintenance-mode middleware both call this on
  // (almost) every request — a short in-memory cache avoids a DB round trip
  // per request while still picking up an admin's change within a few
  // seconds. Invalidated eagerly on every write below anyway.
  private cached: { config: any; expiresAt: number } | null = null;
  private readonly CACHE_TTL_MS = 5000;

  private async getRawConfig() {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.config;
    const config = await this.model.findOneAndUpdate({}, {}, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.cached = { config, expiresAt: Date.now() + this.CACHE_TTL_MS };
    return config;
  }

  private invalidateCache() {
    this.cached = null;
  }

  async getConfig() {
    const config = await this.getRawConfig();
    return { success: true, data: config };
  }

  /** Used by FeatureFlagGuard — true unless an admin has explicitly turned this flag off. */
  async isFeatureEnabled(flag: FeatureFlagKey): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.featureFlags?.[flag] !== false;
  }

  /** Used by the maintenance-mode middleware in main.ts. */
  async isMaintenanceMode(): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.maintenanceMode === true;
  }

  /** How many banners may be simultaneously visible for a given placement — read-side cap only, never a create-time limit. */
  async getPlacementLimit(key: PlacementLimitKey): Promise<number> {
    const config = await this.getRawConfig();
    return config.placementLimits?.[key] ?? 4;
  }

  /** The admin-configured rate card for a placement (hourly/daily/weekly/monthly + multipliers + festival overrides), or {} if unset. */
  async getPromotionPricing(placement: string): Promise<Record<string, any>> {
    const config = await this.getRawConfig();
    return config.promotionPricing?.[placement] ?? {};
  }

  /** Used by FinanceService to gate on-demand withdrawals and the scheduled auto-payout batch per currency. */
  async getPayoutMinimum(currency: string): Promise<number> {
    const config = await this.getRawConfig();
    return currency === 'PKR' ? config.payoutConfig?.minPayoutPKR ?? 1500 : config.payoutConfig?.minPayoutUSD ?? 5;
  }

  /** Used by checkout (to decide whether to offer the option) and by the manual-payments module (bank details + FX rate shown to the buyer). */
  async getManualPaymentConfig() {
    const config = await this.getRawConfig();
    return config.manualPaymentConfig;
  }

  async isManualPaymentEnabled(): Promise<boolean> {
    const config = await this.getRawConfig();
    return config.manualPaymentConfig?.enabled === true;
  }

  /** Used by ExchangeRateService's cron refresh + sanity/abnormal-jump checks. */
  async getFxConfig() {
    const config = await this.getRawConfig();
    return config.fxConfig;
  }

  /**
   * The real, dynamic list of currencies this platform accepts — always
   * includes 'USD' first (the fixed pivot, no band since it's never rate-
   * checked). Lazily seeds `fxConfig.enabledCurrencies` exactly once, the
   * first time this is ever called on a given (brand-new) database —
   * genuinely Shopify-style: EVERY real ISO-4217 currency this platform's
   * own metadata table knows about (`ALL_CURRENCY_CODES`) is on from day
   * one, not just the ~30 major ones a free provider happens to auto-price —
   * an admin having to click a button just to turn on real, ordinary
   * currencies isn't a real access-control decision, it's busywork, so a
   * fresh platform doesn't require one. PKR keeps its own real, historical
   * band (from the deprecated `sanityBandMinPKR`/`sanityBandMaxPKR` fields,
   * so a pre-existing platform's behavior is byte-identical); every other
   * currency gets a deliberately wide, generic sanity band (0.0001–1,000,000
   * per USD) — this platform has no real-world per-currency range to
   * hardcode without re-introducing the "source-code constant" problem this
   * whole design exists to avoid; the band's actual job is only to catch a
   * garbage FIRST rate (negative/zero/decimal-point error), while day-to-day
   * movement is what `abnormalJumpAlertPercent` actually polices (see
   * `ingestRate`). Currencies Frankfurter/ExchangeRate-API can auto-refresh
   * (`refreshFromProvider`, ~168 of the ~152 in this table) get a real
   * rate on the very next daily cron; the rare currency neither free
   * provider prices (BZD, as of this writing) still needs a real admin
   * action (a manual rate via the FX override endpoint) — that's a genuine
   * "someone has to say I'll keep this one updated by hand" case, not
   * busywork. NOTE: this seed only ever runs ONCE per database — a platform
   * that was already live before this change keeps whatever it was already
   * seeded with; `AdminConfigService.enableAllCurrencies` is the one-time
   * catch-up action for that case, not something a fresh deployment needs.
   */
  async getEnabledCurrencies(): Promise<{ code: string; sanityBandMin: number | null; sanityBandMax: number | null }[]> {
    let config = await this.getRawConfig();
    if (!config.fxConfig?.enabledCurrencies || config.fxConfig.enabledCurrencies.length === 0) {
      const seedEntries = ALL_CURRENCY_CODES
        .filter((code) => code !== 'USD')
        .map((code) =>
          code === 'PKR'
            ? { code: 'PKR', sanityBandMin: config.fxConfig?.sanityBandMinPKR ?? 150, sanityBandMax: config.fxConfig?.sanityBandMaxPKR ?? 450 }
            : { code, sanityBandMin: 0.0001, sanityBandMax: 1_000_000 },
        );
      config = await this.model.findOneAndUpdate(
        {},
        { $set: { 'fxConfig.enabledCurrencies': seedEntries } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      this.invalidateCache();
    }
    return [
      { code: 'USD', sanityBandMin: null, sanityBandMax: null },
      ...config.fxConfig.enabledCurrencies.map((c: any) => ({ code: c.code, sanityBandMin: c.sanityBandMin, sanityBandMax: c.sanityBandMax })),
    ];
  }

  /** Admin-only — adds a new currency the platform will accept, with its own
   *  real sanity band (see EnabledCurrencyConfig's own doc comment for why a
   *  per-currency band is required, not a shared global one). Validated
   *  against the real, complete ISO-4217 table (`isRealCurrencyCode`), not a
   *  hand-picked shortlist — any real-world currency can be enabled, no
   *  source-code change required. */
  async addCurrency(code: string, sanityBandMin: number, sanityBandMax: number, meta: AuditMeta) {
    const normalized = code.trim().toUpperCase();
    if (!isRealCurrencyCode(normalized)) {
      throw new BadRequestException(`"${normalized}" is not a real ISO-4217 currency code`);
    }
    if (normalized === 'USD') {
      throw new BadRequestException('USD is always enabled as the platform pivot — nothing to add');
    }
    if (sanityBandMin <= 0 || sanityBandMax <= sanityBandMin) {
      throw new BadRequestException('sanityBandMax must be greater than sanityBandMin, both must be positive');
    }
    const existing = await this.getEnabledCurrencies();
    if (existing.some((c) => c.code === normalized)) {
      throw new BadRequestException(`${normalized} is already enabled`);
    }
    const config = await this.model.findOneAndUpdate(
      {},
      { $push: { 'fxConfig.enabledCurrencies': { code: normalized, sanityBandMin, sanityBandMax, enabledAt: new Date() } } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    this.invalidateCache();
    await this.logChange('fx_currency_added', `Enabled ${normalized} for checkout/settlement (band [${sanityBandMin}, ${sanityBandMax}])`, meta);
    return { success: true, message: `${normalized} enabled`, data: config.fxConfig };
  }

  async updateCurrencyBand(code: string, sanityBandMin: number, sanityBandMax: number, meta: AuditMeta) {
    const normalized = code.trim().toUpperCase();
    if (sanityBandMin <= 0 || sanityBandMax <= sanityBandMin) {
      throw new BadRequestException('sanityBandMax must be greater than sanityBandMin, both must be positive');
    }
    const config = await this.model.findOneAndUpdate(
      { 'fxConfig.enabledCurrencies.code': normalized },
      { $set: { 'fxConfig.enabledCurrencies.$.sanityBandMin': sanityBandMin, 'fxConfig.enabledCurrencies.$.sanityBandMax': sanityBandMax } },
      { new: true },
    );
    if (!config) throw new NotFoundException(`${normalized} is not currently enabled`);
    this.invalidateCache();
    await this.logChange('fx_currency_band_updated', `Updated ${normalized}'s sanity band to [${sanityBandMin}, ${sanityBandMax}]`, meta);
    return { success: true, message: `${normalized} band updated`, data: config.fxConfig };
  }

  /** Refuses to remove a currency any real store currently prices in — a
   *  store's `baseCurrency` is otherwise-immutable (see Store.baseCurrency's
   *  own doc comment), so disabling it here would leave that store unable
   *  to ever price/checkout again. Matches this codebase's established
   *  "check real usage before allowing removal" convention (e.g. Media
   *  Library's `checkUsage`). */
  async removeCurrency(code: string, meta: AuditMeta) {
    const normalized = code.trim().toUpperCase();
    if (normalized === 'USD') {
      throw new BadRequestException('USD is the platform pivot and cannot be removed');
    }
    const inUseByStore = await this.databaseService.repositories.storeModel.exists({ baseCurrency: normalized });
    if (inUseByStore) {
      throw new BadRequestException(`Cannot remove ${normalized} — at least one store still prices in it`);
    }
    const config = await this.model.findOneAndUpdate(
      {},
      { $pull: { 'fxConfig.enabledCurrencies': { code: normalized } } },
      { new: true },
    );
    this.invalidateCache();
    await this.logChange('fx_currency_removed', `Disabled ${normalized} for new checkout/settlement`, meta);
    return { success: true, message: `${normalized} disabled`, data: config?.fxConfig };
  }

  /**
   * Admin-only bulk action: enables every real ISO-4217 currency in this
   * platform's own metadata table (`ALL_CURRENCY_CODES`) that isn't already
   * enabled — the "turn on the platform's full currency list" counterpart to
   * `addCurrency`'s one-at-a-time path, for an admin who wants every real
   * currency live rather than adding ~120 of them by hand. Every newly-added
   * currency gets the same generic wide band already used for the
   * Frankfurter-auto-seeded set (see `getEnabledCurrencies`'s own doc
   * comment for why this platform has no real per-currency range to
   * hardcode) — a currency's rate still goes through `ingestRate`'s real
   * sanity/abnormal-jump checks on every future refresh; this band only
   * guards against a garbage FIRST rate. `ExchangeRateService.refreshFromProvider`
   * (Frankfurter + ExchangeRate-API) auto-refreshes every one of these going
   * forward except the rare real currency neither free provider prices at
   * all — that one still needs a manual admin rate via the FX override
   * endpoint, same as always.
   */
  async enableAllCurrencies(meta: AuditMeta): Promise<{ success: true; message: string; added: string[]; alreadyEnabledCount: number }> {
    const existing = await this.getEnabledCurrencies();
    const existingCodes = new Set(existing.map((c) => c.code));
    const toAdd = ALL_CURRENCY_CODES.filter((code) => code !== 'USD' && !existingCodes.has(code));
    if (toAdd.length === 0) {
      return { success: true, message: 'Every real currency is already enabled', added: [], alreadyEnabledCount: existingCodes.size };
    }
    const newEntries = toAdd.map((code) => ({ code, sanityBandMin: 0.0001, sanityBandMax: 1_000_000, enabledAt: new Date() }));
    await this.model.findOneAndUpdate(
      {},
      { $push: { 'fxConfig.enabledCurrencies': { $each: newEntries } } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    this.invalidateCache();
    await this.logChange('fx_currency_added', `Bulk-enabled ${toAdd.length} currencies for checkout/settlement: ${toAdd.join(', ')}`, meta);
    return { success: true, message: `${toAdd.length} currencies enabled`, added: toAdd, alreadyEnabledCount: existingCodes.size };
  }

  private async logChange(action: string, description: string, meta: AuditMeta) {
    this.activityLogService.log({
      storeId: 'platform',
      category: 'settings',
      action,
      description,
      actorId: meta.adminId,
      actorRole: 'admin',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  async updateFeatureFlags(dto: UpdateFeatureFlagsDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`featureFlags.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('feature_flags_updated', `Feature flags updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Feature flags updated', data: config };
  }

  async updateAiConfig(dto: UpdateAiConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    if (dto.monthlyCreditLimit !== undefined) set['aiConfig.monthlyCreditLimit'] = dto.monthlyCreditLimit;
    if (dto.aiModel !== undefined) set['aiConfig.aiModel'] = dto.aiModel;
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('ai_config_updated', `AI config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'AI config updated', data: config };
  }

  async updateEmailConfig(dto: UpdateEmailConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`emailConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('email_config_updated', `Email config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Email config updated', data: config };
  }

  async updatePlacementLimits(dto: UpdatePlacementLimitsDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`placementLimits.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('placement_limits_updated', `Placement visible-count limits updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Placement limits updated', data: config };
  }

  async updatePromotionPricing(dto: UpdatePromotionPricingDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [placement, rateCard] of Object.entries(dto)) {
      if (rateCard !== undefined) set[`promotionPricing.${placement}`] = rateCard;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('promotion_pricing_updated', `Promotion pricing updated for: ${Object.keys(dto).join(', ')}`, meta);
    return { success: true, message: 'Promotion pricing updated', data: config };
  }

  async updatePayoutConfig(dto: UpdatePayoutConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`payoutConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('payout_config_updated', `Payout config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'Payout config updated', data: config };
  }

  async updateManualPaymentConfig(dto: UpdateManualPaymentConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`manualPaymentConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    // Bank account numbers/IBAN intentionally omitted from the audit description — full values are in `dto`/DB, not duplicated into the activity log.
    await this.logChange('manual_payment_config_updated', `Manual payment config updated (enabled=${config.manualPaymentConfig?.enabled}, rate=${config.manualPaymentConfig?.usdToPkrRate})`, meta);
    return { success: true, message: 'Manual payment config updated', data: config };
  }

  async updateFxConfig(dto: UpdateFxConfigDto, meta: AuditMeta) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) set[`fxConfig.${key}`] = value;
    }
    const config = await this.model.findOneAndUpdate({}, { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    this.invalidateCache();
    await this.logChange('fx_config_updated', `FX config updated: ${JSON.stringify(dto)}`, meta);
    return { success: true, message: 'FX config updated', data: config };
  }

  async setMaintenanceMode(maintenanceMode: boolean, meta: AuditMeta) {
    const config = await this.model.findOneAndUpdate(
      {},
      { $set: { maintenanceMode } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    this.invalidateCache();
    await this.logChange('maintenance_mode_toggled', `Maintenance mode set to ${maintenanceMode}`, {
      ...meta,
    });
    return { success: true, message: 'Maintenance mode updated', data: config };
  }
}
