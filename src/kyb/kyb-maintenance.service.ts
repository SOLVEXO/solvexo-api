/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Store, StoreDocument } from '../store/schemas/store.schema';
import { UploadService } from '../upload/upload.service';
import { KybAuditService } from './kyb-audit.service';
import { KybCrypto } from './kyb-field-crypto';
import { BUSY, JobLeaseService } from '../common/job-lease/job-lease.service';
import { failClosed } from './kyb.service';
import { KybSettings, KybSettingsDocument, StoreKyb, StoreKybDocument } from './kyb.schemas';

const FIELDS = [['cnicEnc', 'cnic'], ['ntnEnc', 'ntn'], ['ibanEnc', 'iban'], ['accountTitleEnc', 'accountTitle']] as const;
const PLATFORM = 'platform';

/** Retention settings + the (disabled-by-default, dry-run-capable) purge job, and encryption-key rotation. */
@Injectable()
export class KybMaintenanceService {
  private readonly logger = new Logger(KybMaintenanceService.name);
  readonly crypto = new KybCrypto();

  constructor(
    @InjectModel(StoreKyb.name) private readonly kyb: Model<StoreKybDocument>,
    @InjectModel(KybSettings.name) private readonly settings: Model<KybSettingsDocument>,
    @InjectModel(Store.name) private readonly stores: Model<StoreDocument>,
    private readonly audit: KybAuditService,
    private readonly upload: UploadService,
    private readonly leases: JobLeaseService,
  ) {}

  // ── retention ───────────────────────────────────────────────────────────────────────────────────────────────────
  async getSettings() {
    const s: any = await this.settings.findOne({ key: 'singleton' }).lean();
    return { afterClosureDays: s?.afterClosureDays ?? null, purgeEnabled: s?.purgeEnabled ?? false, updatedAt: s?.updatedAt ?? null, updatedBy: s?.updatedBy ?? null, policy: 'Documents are kept while the store is active. After closure they are kept for `afterClosureDays` and then deleted — but only when purgeEnabled is true. There is NO default period: nothing is deleted until the owner sets the legal period.' };
  }

  async updateSettings(adminId: string, dto: { afterClosureDays?: number | null; purgeEnabled?: boolean }, ctx: { ip?: string; userAgent?: string } = {}) {
    const days = dto.afterClosureDays;
    if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 30 || days > 3650)) throw new BadRequestException({ code: 'INVALID_RETENTION', message: 'afterClosureDays must be a whole number of days between 30 and 3650, or null' });
    const cur = await this.getSettings();
    const next = { afterClosureDays: days === undefined ? cur.afterClosureDays : days, purgeEnabled: dto.purgeEnabled ?? cur.purgeEnabled };
    if (next.purgeEnabled && next.afterClosureDays === null) throw new BadRequestException({ code: 'RETENTION_PERIOD_REQUIRED', message: 'Set the retention period before enabling deletion' });
    await this.settings.updateOne({ key: 'singleton' }, { $set: { ...next, updatedBy: adminId } }, { upsert: true });
    await this.audit.record(PLATFORM, { type: 'admin', id: adminId, ...ctx }, 'kyb_retention_settings_changed', { from: { afterClosureDays: cur.afterClosureDays, purgeEnabled: cur.purgeEnabled }, to: next });
    return this.getSettings();
  }

  /**
   * Deletes the documents and the encrypted fields of applications whose store was closed (`Store.isDelete`) more than `afterClosureDays`
   * ago (closure time = the store's last update). `dryRun` (the default) changes nothing and reports who would be purged. Refuses to
   * run when deletion is disabled or no period is set. The submission row itself, its history and the audit trail are kept.
   */
  async runRetention(opts: { dryRun?: boolean; now?: Date; actor?: { type: 'admin' | 'system'; id?: string | null } } = {}): Promise<any> {
    if (opts.dryRun === false) {
      // a real purge runs on ONE instance at a time (the cron on every server, plus a manual run from the admin UI)
      const r = await this.leases.withLease('kyb:retention', 15 * 60_000, () => this.runRetentionLocked(opts));
      return r === BUSY ? { skipped: true, reason: 'another_instance_is_running_it', dryRun: false, eligible: 0, purged: 0 } : r;
    }
    return this.runRetentionLocked(opts);
  }

  private async runRetentionLocked(opts: { dryRun?: boolean; now?: Date; actor?: { type: 'admin' | 'system'; id?: string | null } }) {
    const dryRun = opts.dryRun !== false; const now = opts.now ?? new Date(); const actor = opts.actor ?? { type: 'system' as const };
    const s = await this.getSettings();
    if (!s.purgeEnabled || s.afterClosureDays === null) return { skipped: true, reason: s.afterClosureDays === null ? 'no_retention_period_set' : 'purge_disabled', dryRun, eligible: 0, purged: 0 };
    const cutoff = new Date(now.getTime() - s.afterClosureDays * 24 * 3600 * 1000);
    const closed: any[] = await this.stores.find({ isDelete: true, updatedAt: { $lt: cutoff } }).select('_id').limit(1000).lean();
    const rows: any[] = await this.kyb.find({ storeId: { $in: closed.map((c) => String(c._id)) }, purgedAt: null }).lean();
    const report = { skipped: false, dryRun, cutoff, eligible: rows.length, purged: 0, failed: 0, stores: rows.map((r) => ({ storeId: r.storeId, documents: (r.documents ?? []).length })) };
    if (dryRun) { await this.audit.record(PLATFORM, actor, 'kyb_retention_dry_run', { eligible: rows.length, cutoff }); return report; }
    for (const r of rows) {
      const mine = await this.leases.withLease(`kyb:purge:${r.storeId}`, 5 * 60_000, async () => {
      try {
        for (const d of r.documents ?? []) await this.upload.deletePrivateFile(d.publicId, d.resourceType); // a failed storage delete aborts THIS store's purge (retried next run)
        await this.kyb.updateOne({ _id: r._id, purgedAt: null }, { $set: { cnicEnc: null, cnicLast4: null, ntnEnc: null, ntnLast4: null, ibanEnc: null, ibanLast4: null, accountTitleEnc: null, documents: [], purgedAt: now }, $push: { history: { action: 'purged', note: 'retention policy', actorId: null, actorRole: 'system', at: now } } });
        await this.audit.record(r.storeId, actor, 'kyb_purged', { documents: (r.documents ?? []).length, afterClosureDays: s.afterClosureDays });
        report.purged++;
      } catch (e: any) { report.failed++; this.logger.error(`KYB purge failed for ${r.storeId}: ${e?.message}`); }
      });
      if (mine === BUSY) continue;
    }
    await this.audit.record(PLATFORM, actor, 'kyb_retention_run', { eligible: rows.length, purged: report.purged, failed: report.failed });
    return report;
  }

  /** Daily at 03:30, only when KYB_RETENTION_JOB_ENABLED=true AND the setting `purgeEnabled` is true. Off by default. */
  @Cron(process.env.KYB_RETENTION_CRON || '30 3 * * *')
  async retentionCron(): Promise<void> {
    if (process.env.KYB_RETENTION_JOB_ENABLED !== 'true') return;
    try { await this.runRetention({ dryRun: false, actor: { type: 'system' } }); } catch (e: any) { this.logger.error(`KYB retention job failed: ${e?.message}`); }
  }

  // ── key rotation ────────────────────────────────────────────────────────────────────────────────────────────────
  /** Re-encrypts every value that is not on the CURRENT key version. Idempotent; safe to stop and re-run; each write is guarded on the old ciphertext. */
  async rotateKeys(opts: { dryRun?: boolean; batchSize?: number } = {}): Promise<any> {
    if (opts.dryRun !== true) {
      const r = await this.leases.withLease('kyb:rotation', 30 * 60_000, () => this.rotateKeysLocked(opts));
      return r === BUSY ? { skipped: true, reason: 'another_rotation_is_running' } : r;
    }
    return this.rotateKeysLocked(opts);
  }

  private async rotateKeysLocked(opts: { dryRun?: boolean; batchSize?: number }) {
    const dryRun = opts.dryRun === true; const batch = opts.batchSize ?? 200;
    failClosed(() => this.crypto.assertReady());
    const current = this.crypto.currentVersion();
    const out = { currentVersion: current, dryRun, scanned: 0, valuesRotated: 0, valuesAlreadyCurrent: 0, failed: 0, remainingOnOldVersions: 0 };
    let lastId: any = null;
    for (;;) {
      const rows: any[] = await this.kyb.find(lastId ? { _id: { $gt: lastId } } : {}).sort({ _id: 1 }).limit(batch).lean();
      if (!rows.length) break;
      for (const r of rows) {
        lastId = r._id; out.scanned++;
        for (const [field, name] of FIELDS) {
          const token = r[field];
          if (!token) continue;
          if (KybCrypto.versionOf(token) === current) { out.valuesAlreadyCurrent++; continue; }
          try {
            const fresh = this.crypto.reencrypt(token, `${r.storeId}:${name}`);
            if (!dryRun) { const w = await this.kyb.updateOne({ _id: r._id, [field]: token }, { $set: { [field]: fresh } }); if (w.modifiedCount === 0) { out.remainingOnOldVersions++; continue; } }
            out.valuesRotated++;
          } catch (e: any) { out.failed++; out.remainingOnOldVersions++; this.logger.error(`KYB rotation failed for store ${r.storeId} field ${name}: ${e?.name}`); }
        }
      }
    }
    if (!dryRun) await this.audit.record(PLATFORM, { type: 'system' }, 'kyb_key_rotation_run', { ...out });
    return out;
  }
}
