/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { resolveStoreCountry } from '../integrations/payment-availability.util';
import { PlatformPlanInvoice, PlatformPlanInvoiceDocument } from '../platform-plans/schemas/platform-plan-invoice.schema';
import { PlatformAddonPurchase } from '../platform-plans/schemas/platform-addon-purchase.schema';
import { TransactionFeeBill, TransactionFeeBillDocument } from '../platform-plans/schemas/transaction-fee-bill.schema';
import { PlatformTaxRecord, PlatformTaxRecordDocument } from './schemas/platform-tax-record.schema';
import { PlatformInvoice, PlatformInvoiceDocument } from './schemas/platform-invoice.schema';
import { PlatformEntityService, PLAN_SUPPLY_TYPE } from './platform-entity.service';
import { determine } from './platform-tax-determination.service';
import { addonChargeFacts, feeBillFacts, LedgerFacts, planInvoiceFacts, taxRecordFacts } from './platform-ledger.util';
import type { LedgerSourceType } from '../tax-core/legal-invoice.types';

export interface LedgerSyncStats {
  enabled: boolean;
  dryRun: boolean;
  skippedReason: 'disabled' | null;
  examined: number;
  created: number; // dry run: rows that WOULD be created
  updated: number;
  unchanged: number;
  racedDuplicates: number;
  bySource: Partial<Record<LedgerSourceType, number>>;
}

const BATCH = 500;
const MAX_BATCHES_PER_SOURCE = 200; // 100k documents per source per run; the next run continues from the same rows (idempotent)

/** Phase 1 switch. Default OFF: with anything but the exact string 'true' the ledger writes nothing. */
export const isPlatformLedgerEnabled = () => String(process.env.PLATFORM_LEDGER_ENABLED ?? '').trim().toLowerCase() === 'true';

/**
 * READ-ONLY SHADOW LEDGER. It only READS billing data (plan invoices, add-on purchases, fee bills, one-off tax records, stores, the tax
 * settings) and WRITES only `platform_invoices`. It does not touch billing, Stripe, subscriptions or any tax authority, and it has no
 * dependency on the FBR module (so it cannot file anything).
 */
@Injectable()
export class PlatformLedgerService {
  private readonly logger = new Logger(PlatformLedgerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly entities: PlatformEntityService,
    @InjectModel(PlatformInvoice.name) private readonly ledger: Model<PlatformInvoiceDocument>,
    @InjectModel(PlatformPlanInvoice.name) private readonly planInvoices: Model<PlatformPlanInvoiceDocument>,
    @InjectModel(PlatformAddonPurchase.name) private readonly addons: Model<any>,
    @InjectModel(TransactionFeeBill.name) private readonly feeBills: Model<TransactionFeeBillDocument>,
    @InjectModel(PlatformTaxRecord.name) private readonly taxRecords: Model<PlatformTaxRecordDocument>,
  ) {}

  isEnabled(): boolean { return isPlatformLedgerEnabled(); }

  /** One pass over every source. `dryRun` never writes. A real run needs PLATFORM_LEDGER_ENABLED=true. Safe to repeat and to run twice at once. */
  async sync(opts: { dryRun: boolean }): Promise<LedgerSyncStats> {
    const stats: LedgerSyncStats = { enabled: this.isEnabled(), dryRun: opts.dryRun, skippedReason: null, examined: 0, created: 0, updated: 0, unchanged: 0, racedDuplicates: 0, bySource: {} };
    if (!opts.dryRun && !stats.enabled) { stats.skippedReason = 'disabled'; return stats; }

    const { entity, rules } = await this.entities.load();
    const countries = new Map<string, string | null>();

    const flush = async (facts: LedgerFacts[]) => {
      if (!facts.length) return;
      await this.fillCountries(facts, countries);
      const rows = facts.map((f) => this.toRow(f, entity, rules, countries.get(f.storeId) ?? null));
      stats.examined += rows.length;
      for (const r of rows) stats.bySource[r.sourceType as LedgerSourceType] = (stats.bySource[r.sourceType as LedgerSourceType] ?? 0) + 1;
      if (opts.dryRun) {
        const existing = await this.ledger.find({ $or: rows.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })) }).select('sourceType sourceId').lean();
        const have = new Set(existing.map((e: any) => `${e.sourceType}|${e.sourceId}`));
        const fresh = rows.filter((r) => !have.has(`${r.sourceType}|${r.sourceId}`)).length;
        stats.created += fresh;
        stats.unchanged += rows.length - fresh;
        return;
      }
      for (const r of rows) await this.upsertRow(r, stats);
    };

    await this.eachBatch(this.planInvoices, { isDelete: false, paidAt: { $ne: null } }, async (docs) => flush(docs.map(planInvoiceFacts).filter((f): f is LedgerFacts => !!f)));
    await this.eachBatch(this.addons, { 'charges.0': { $exists: true } }, async (docs) => flush(docs.flatMap(addonChargeFacts)));
    await this.eachBatch(this.feeBills, { isDelete: false, status: 'paid' }, async (docs) => flush(docs.map(feeBillFacts).filter((f): f is LedgerFacts => !!f)));
    await this.eachBatch(this.taxRecords, {}, async (docs) => flush(docs.map(taxRecordFacts).filter((f): f is LedgerFacts => !!f)));

    this.logger.log(`Platform ledger ${opts.dryRun ? 'DRY RUN' : 'sync'}: examined ${stats.examined}, created ${stats.created}, updated ${stats.updated}, unchanged ${stats.unchanged}, raced ${stats.racedDuplicates}`);
    return stats;
  }

  /** Pages through a source by _id. `.lean()` on purpose: Mongoose must not fill defaults (a missing tax field must stay missing). */
  private async eachBatch(model: Model<any>, filter: Record<string, any>, fn: (docs: any[]) => Promise<void>): Promise<void> {
    let last: any = null;
    for (let i = 0; i < MAX_BATCHES_PER_SOURCE; i++) {
      const q = last ? { ...filter, _id: { $gt: last } } : filter;
      const docs: any[] = await model.find(q).sort({ _id: 1 }).limit(BATCH).lean();
      if (!docs.length) return;
      await fn(docs);
      last = docs[docs.length - 1]._id;
      if (docs.length < BATCH) return;
    }
  }

  private async fillCountries(facts: LedgerFacts[], cache: Map<string, string | null>): Promise<void> {
    const need = [...new Set(facts.map((f) => f.storeId).filter((id) => !cache.has(id)))];
    if (!need.length) return;
    const valid = need.filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const stores: any[] = valid.length ? await this.db.repositories.storeModel.find({ _id: { $in: valid } }).select('country baseCurrency').lean() : [];
    for (const s of stores) cache.set(String(s._id), resolveStoreCountry(s));
    for (const id of need) if (!cache.has(id)) cache.set(id, null);
  }

  private toRow(f: LedgerFacts, entity: any, rules: any[], customerCountry: string | null) {
    const d = determine({ entity, customerCountry, supplyType: PLAN_SUPPLY_TYPE, rules, taxKnown: f.taxKnown, chargedTaxUSD: f.chargedTaxUSD, taxLines: f.taxLines });
    return {
      sourceType: f.sourceType, sourceId: f.sourceId, issuerEntityKey: entity.entityKey,
      customer: { storeId: f.storeId, sellerId: f.sellerId, country: customerCountry },
      currency: 'USD', paidAt: f.paidAt, taxKnown: f.taxKnown, netUSD: f.netUSD, chargedTaxUSD: f.chargedTaxUSD, totalUSD: f.totalUSD, taxLines: f.taxLines,
      refundedUSD: f.refundedUSD, status: f.status, routing: d.routing, determination: d.determination, warnings: d.warnings,
    };
  }

  /** One row per (sourceType, sourceId). Two runs at once: the loser gets E11000 and just updates the winner's row. */
  private async upsertRow(row: ReturnType<PlatformLedgerService['toRow']>, stats: LedgerSyncStats): Promise<void> {
    const key = { sourceType: row.sourceType, sourceId: row.sourceId };
    const { sourceType: _a, sourceId: _b, ...fields } = row;
    void _a; void _b;
    try {
      const res: any = await this.ledger.updateOne(key, { $set: fields, $setOnInsert: { ...key, createdAt: new Date() } }, { upsert: true, timestamps: false });
      if (res?.upsertedCount) stats.created++;
      else if (res?.modifiedCount) stats.updated++;
      else stats.unchanged++;
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      stats.racedDuplicates++;
      const res: any = await this.ledger.updateOne(key, { $set: fields }, { timestamps: false });
      if (res?.modifiedCount) stats.updated++; else stats.unchanged++;
    }
  }
}
