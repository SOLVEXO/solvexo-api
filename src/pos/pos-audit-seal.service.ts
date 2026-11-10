/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { JobLeaseService, BUSY } from '../common/job-lease/job-lease.service';
import { resolveStoreTimeZone } from '../common/store-timezone.util';
import { localDay } from './pos-day.util';

/** The append-only records a store-day seal covers (repository name → label). Mutable documents (sales, sessions…) are not sealed: their history lives in these. */
export const SEALED_COLLECTIONS: Record<string, string> = {
  posAuditLogModel: 'audit_log', posPaymentModel: 'payments', posRefundModel: 'refunds', posCreditNoteModel: 'credit_notes', stockMovementModel: 'stock_movements',
  storeCreditEntryModel: 'store_credit', supplierLedgerEntryModel: 'supplier_ledger', purchaseReceiptModel: 'goods_receipts', posExpenseModel: 'expenses',
  posExpenseEventModel: 'expense_events', posAttendanceEventModel: 'attendance',
};
export const SEAL_ALGORITHM = 'sha256-v1';
/** a day is sealed only once it has been over for this long (writes in flight, clock skew) */
const GRACE_MS = 2 * 3_600_000;
const MAX_DAYS_PER_RUN = 400;

/** Stable JSON: keys sorted, dates ISO, ObjectIds / Longs / Decimals as strings — the same record always hashes the same. */
export function canonical(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'object' && (v._bsontype === 'ObjectId' || v._bsontype === 'ObjectID')) return JSON.stringify(String(v));
  if (typeof v === 'object' && (v._bsontype === 'Long' || v._bsontype === 'Decimal128' || v._bsontype === 'Int32' || v._bsontype === 'Double')) return JSON.stringify(String(v));
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => k !== '__v').sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * G4.3 — nightly sealing of the store's append-only records (owner decision 4): per store, per store-day (its time zone), a hash over that day's records chained
 * to the previous seal, stored append-only. Lease-protected (only one instance seals); idempotent (a sealed day is never sealed again — unique index).
 * Records are selected by INSERTION time (the ObjectId), so a late offline sync or a backfill with an old business date lands on the day it was WRITTEN.
 */
@Injectable()
export class PosAuditSealService {
  private readonly logger = new Logger(PosAuditSealService.name);
  constructor(private readonly db: DatabaseService, private readonly leases: JobLeaseService) {}
  private get r(): any { return this.db.repositories; }

  private async tzOf(storeId: string): Promise<string> {
    const st: any = await this.r.storeModel.findById(storeId).select('timezone country').lean().catch(() => null);
    return resolveStoreTimeZone(st);
  }
  /** The hash of one store-day as it is in the database NOW. */
  async digest(storeId: string, from: Date, to: Date, prevHash: string | null) {
    const idRange = { $gte: Types.ObjectId.createFromTime(Math.floor(from.getTime() / 1000)), $lt: Types.ObjectId.createFromTime(Math.floor(to.getTime() / 1000)) };
    const parts: Record<string, { count: number; hash: string }> = {};
    let count = 0;
    for (const [repo, label] of Object.entries(SEALED_COLLECTIONS)) {
      const model = this.r[repo]; if (!model) continue;
      const h = createHash('sha256'); let n = 0;
      const cur = model.collection.find({ storeId, _id: idRange }).sort({ _id: 1 });
      for await (const doc of cur) { h.update(sha(canonical(doc))); h.update('\n'); n++; }
      parts[label] = { count: n, hash: h.digest('hex') };
      count += n;
    }
    const hash = sha(`${SEAL_ALGORITHM}|${storeId}|${from.toISOString()}|${to.toISOString()}|${prevHash ?? ''}|${canonical(parts)}`);
    return { parts, count, hash };
  }

  /** Seals every finished, unsealed day of one store, oldest first (the chain needs order). Returns the days sealed. */
  async sealStore(storeId: string, now: Date = new Date()): Promise<string[]> {
    const tz = await this.tzOf(storeId);
    const last: any = await this.r.posAuditSealModel.findOne({ storeId }).sort({ day: -1 }).lean();
    let day = last ? localDay(new Date(new Date(last.to).getTime() + 3_600_000), tz) : null;
    if (!day) {
      // the first day the store wrote anything sealable
      let first: Date | null = null;
      for (const repo of Object.keys(SEALED_COLLECTIONS)) {
        const d: any = this.r[repo] ? await this.r[repo].collection.find({ storeId }).sort({ _id: 1 }).limit(1).project({ _id: 1 }).next() : null;
        if (d?._id?.getTimestamp) { const ts = d._id.getTimestamp(); if (!first || ts < first) first = ts; }
      }
      if (!first) return [];
      day = localDay(first, tz);
    }
    const done: string[] = [];
    let prev: string | null = last?.hash ?? null;
    for (let i = 0; i < MAX_DAYS_PER_RUN && day.end.getTime() + GRACE_MS <= now.getTime(); i++) {
      const d = await this.digest(storeId, day.start, day.end, prev);
      try {
        await this.r.posAuditSealModel.create({ storeId, day: day.key, timeZone: tz, from: day.start, to: day.end, algorithm: SEAL_ALGORITHM, parts: d.parts, count: d.count, prevHash: prev, hash: d.hash });
      } catch (e: any) { if (e?.code === 11000) return done; throw e; } // another sealer got there first: stop, the next run continues from its seal
      done.push(day.key); prev = d.hash;
      day = localDay(new Date(day.end.getTime() + 3_600_000), tz);
    }
    return done;
  }

  async sealAll(now: Date = new Date()): Promise<{ stores: number; days: number }> {
    const ids = new Set<string>((await this.r.posSettingsModel.distinct('storeId')).map(String));
    for (const id of await this.r.posAuditLogModel.distinct('storeId')) ids.add(String(id));
    let days = 0;
    for (const id of ids) {
      try { days += (await this.sealStore(id, now)).length; }
      catch (e: any) { this.logger.error(`audit seal failed for store ${id}: ${e?.message}`); }
    }
    return { stores: ids.size, days };
  }

  /** Nightly (UTC 01:20; each store's day is sealed in its own zone). One instance only: the lease. */
  @Cron(process.env.POS_AUDIT_SEAL_CRON || '20 1 * * *')
  async nightly(): Promise<void> {
    const r = await this.leases.withLease('pos:audit-seal', 30 * 60_000, () => this.sealAll());
    if (r === BUSY) this.logger.debug('audit seal: another instance holds the lease');
    else this.logger.log(`audit seal: ${r.days} day(s) sealed over ${r.stores} store(s)`);
  }

  /**
   * Recomputes every seal of a store in [from, to] and compares. `ok` = untouched; `changed` = a sealed record was edited, deleted or a record was inserted with a
   * back-dated id (the part that differs is named, with the counts then and now); `broken_chain` = a seal's prevHash is not the previous seal's hash.
   */
  async verify(storeId: string, from?: string, to?: string) {
    const filter: any = { storeId };
    if (from || to) filter.day = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const seals: any[] = await this.r.posAuditSealModel.find(filter).sort({ day: 1 }).lean();
    const out: any[] = [];
    let prevSeal: any = from ? await this.r.posAuditSealModel.findOne({ storeId, day: { $lt: from } }).sort({ day: -1 }).lean() : null;
    for (const s of seals) {
      const d = await this.digest(storeId, new Date(s.from), new Date(s.to), s.prevHash);
      const chainOk = prevSeal ? s.prevHash === prevSeal.hash : true;
      const changedParts = Object.keys({ ...s.parts, ...d.parts }).filter((k) => s.parts?.[k]?.hash !== d.parts?.[k]?.hash).map((k) => ({ part: k, sealedCount: s.parts?.[k]?.count ?? 0, nowCount: d.parts?.[k]?.count ?? 0 }));
      out.push({ day: s.day, status: !chainOk ? 'broken_chain' : d.hash === s.hash ? 'ok' : 'changed', sealedAt: s.sealedAt, count: s.count, changedParts });
      prevSeal = s;
    }
    return { storeId, days: out.length, ok: out.every((x) => x.status === 'ok'), results: out };
  }
}
