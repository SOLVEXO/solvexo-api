/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import {
  CATALOG_VERSION, PLAN_CATALOG, assertCatalogValid, buildFeatureBullets, validatePlanPricing,
  type CatalogPlan,
} from './platform-plan.catalog';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keeps the PlatformPlan collection in line with the code-defined catalog
 * (platform-plan.catalog.ts):
 *  - at boot the catalog itself is validated — an inconsistent catalog fails the
 *    deploy instead of reaching sellers;
 *  - missing catalog plans are created; existing plans with the same name (Basic /
 *    Grow / Advanced from before plans were code-defined) are ADOPTED in place, so
 *    every store subscription pointing at them keeps working;
 *  - an adopted/older plan is aligned once per CATALOG_VERSION: its limits and
 *    features come from the catalog, while what the admin owns (price, intro offer,
 *    name, text, visibility) and the money-critical transaction fee are kept;
 *  - feature bullets are regenerated from the limits, so text and enforcement
 *    can't drift apart.
 * Safe to run on every boot and from several replicas at once (idempotent; the
 * unique `key` index stops a double create).
 */
@Injectable()
export class PlatformPlanCatalogService implements OnModuleInit {
  private readonly logger = new Logger(PlatformPlanCatalogService.name);

  constructor(private readonly db: DatabaseService) {}

  private get planModel() { return this.db.repositories.platformPlanModel; }

  async onModuleInit() {
    assertCatalogValid(); // throws → the app does not start with a broken catalog
    try {
      await this.syncCatalog();
    } catch (err: any) {
      // A transient DB problem must not take the API down — the next boot retries.
      this.logger.error(`Platform plan catalog sync failed: ${err?.message}`, err?.stack);
    }
  }

  async syncCatalog(): Promise<void> {
    const sorted = [...PLAN_CATALOG].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const plan of sorted) await this.syncOne(plan);
    await this.refreshBullets();
  }

  private async syncOne(plan: CatalogPlan): Promise<void> {
    let doc: any = await this.planModel.findOne({ key: plan.key, isDelete: false });
    if (!doc) {
      // Adopt a pre-catalog plan of the same name instead of creating a duplicate.
      doc = await this.planModel
        .findOne({
          $or: [{ key: null }, { key: { $exists: false } }],
          isDelete: false,
          name: new RegExp(`^${escapeRegex(plan.name)}$`, 'i'),
        })
        .sort({ sortOrder: 1 });
    }

    if (!doc) {
      try {
        await this.planModel.create({
          key: plan.key, catalogVersion: CATALOG_VERSION,
          name: plan.name, description: plan.description, badge: plan.badge, sortOrder: plan.sortOrder,
          isFree: false, isCustomPricing: plan.isCustomPricing,
          monthlyPriceUSD: plan.monthlyPriceUSD, yearlyPriceUSD: plan.yearlyPriceUSD, trialDays: 0,
          limits: { ...plan.limits },
          status: 'active', isPubliclyVisible: true,
          introOfferEnabled: !!plan.intro, introPriceUSD: plan.intro?.priceUSD ?? null, introDurationCycles: plan.intro?.durationCycles ?? null,
          gracePeriodDays: plan.gracePeriodDays, featureBullets: [],
        });
        this.logger.log(`Created platform plan "${plan.name}" (${plan.key})`);
      } catch (err: any) {
        if (err?.code !== 11000) throw err; // another replica created it first — fine
      }
      return;
    }

    if (doc.key === plan.key && (doc.catalogVersion ?? 0) >= CATALOG_VERSION) return; // already aligned

    // ── Align an adopted / older plan once per catalog version ─────────────

    const before = `${doc.monthlyPriceUSD}|${doc.yearlyPriceUSD}|${doc.introOfferEnabled}|${doc.introPriceUSD}|${doc.introDurationCycles}`;

    doc.key = plan.key;
    doc.catalogVersion = CATALOG_VERSION;
    doc.isFree = false;
    doc.isCustomPricing = plan.isCustomPricing;
    doc.sortOrder = plan.sortOrder;
    doc.status = 'active';
    // transactionFeeRate changed meaning in catalog v3 (an old value was a commission on EVERY sale; it is now the
    // third-party gateway fee), so the catalog value replaces it rather than being carried over.
    doc.limits = { ...plan.limits };
    if (!doc.description) doc.description = plan.description;
    // A badge that just repeats the plan's name ("Basic" on Basic) is noise — use the catalog's.
    if (!doc.badge || String(doc.badge).trim().toLowerCase() === String(doc.name).trim().toLowerCase()) doc.badge = plan.badge;
    if (doc.isPubliclyVisible === undefined || doc.isPubliclyVisible === null) doc.isPubliclyVisible = true;

    if (plan.isCustomPricing) {
      doc.monthlyPriceUSD = null; doc.yearlyPriceUSD = null;
      doc.introOfferEnabled = false; doc.introPriceUSD = null; doc.introDurationCycles = null;
    } else {
      if (!(typeof doc.monthlyPriceUSD === 'number' && doc.monthlyPriceUSD > 0)) doc.monthlyPriceUSD = plan.monthlyPriceUSD;
      const pricingProblems = validatePlanPricing({
        monthlyPriceUSD: doc.monthlyPriceUSD, yearlyPriceUSD: doc.yearlyPriceUSD ?? null,
        introOfferEnabled: !!doc.introOfferEnabled, introPriceUSD: doc.introPriceUSD ?? null, introDurationCycles: doc.introDurationCycles ?? null,
      });
      if (doc.yearlyPriceUSD == null || pricingProblems.some(p => p.startsWith('Yearly'))) doc.yearlyPriceUSD = plan.yearlyPriceUSD;
      if (pricingProblems.some(p => p.toLowerCase().includes('intro'))) {
        doc.introOfferEnabled = !!plan.intro;
        doc.introPriceUSD = plan.intro?.priceUSD ?? null;
        doc.introDurationCycles = plan.intro?.durationCycles ?? null;
      }
    }

    // Stripe Prices/Coupons are immutable — drop the cached ids if what they mirror changed.
    const after = `${doc.monthlyPriceUSD}|${doc.yearlyPriceUSD}|${doc.introOfferEnabled}|${doc.introPriceUSD}|${doc.introDurationCycles}`;
    if (before !== after) {
      doc.stripeMonthlyPriceId = null; doc.stripeYearlyPriceId = null; doc.stripeIntroCouponId = null;
    }

    await doc.save();
    this.logger.log(`Aligned platform plan "${doc.name}" (${plan.key}) to catalog v${CATALOG_VERSION}`);
  }

  /** Regenerates every catalog plan's marketing bullets from its current limits
   *  (each lists only what's new vs the plan below it, so an edit to one plan can
   *  change its neighbour's text too — hence all of them, in tier order). */
  async refreshBullets(): Promise<void> {
    const docs: any[] = await this.planModel.find({ key: { $type: 'string' }, isDelete: false }).sort({ sortOrder: 1 });
    for (let i = 0; i < docs.length; i++) {
      const bullets = buildFeatureBullets(docs[i], i > 0 ? docs[i - 1] : null);
      if (JSON.stringify(bullets) !== JSON.stringify(docs[i].featureBullets ?? [])) {
        docs[i].featureBullets = bullets;
        await docs[i].save();
      }
    }
  }
}
