/* eslint-disable no-console */
/**
 * KYB encryption key rotation. Re-encrypts every KYB value that is not on the CURRENT key version.
 *
 *   MONGO_URI=… KYB_ENC_KEY_V1=… KYB_ENC_KEY_V2=… KYB_ENC_KEY_CURRENT=2 npx ts-node -r tsconfig-paths/register src/scripts/kyb-rotate-key.ts --dry-run
 *   MONGO_URI=… KYB_ENC_KEY_V1=… KYB_ENC_KEY_V2=… KYB_ENC_KEY_CURRENT=2 npx ts-node -r tsconfig-paths/register src/scripts/kyb-rotate-key.ts
 *
 * Idempotent and resumable (re-run any time). Remove the old key (`KYB_ENC_KEY_V1`) only after a run reports `remainingOnOldVersions: 0`.
 * Does not read `.env`: pass the keys and MONGO_URI explicitly. Procedure: pos/docs/pos-blueprint/KYB_KEY_ROTATION.md
 */
import mongoose from 'mongoose';
import { KybMaintenanceService } from '../kyb/kyb-maintenance.service';
import { KybAuditService } from '../kyb/kyb-audit.service';
import { KybAuditEvent, KybAuditEventSchema, KybSettings, KybSettingsSchema, StoreKyb, StoreKybSchema } from '../kyb/kyb.schemas';
import { Store, StoreSchema } from '../store/schemas/store.schema';
import { JobLease, JobLeaseSchema } from '../common/job-lease/job-lease.schema';
import { JobLeaseService } from '../common/job-lease/job-lease.service';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('Usage: MONGO_URI=… KYB_ENC_KEY_V<n>=… KYB_ENC_KEY_CURRENT=<n> kyb-rotate-key.ts [--dry-run]'); process.exit(2); }
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    const kyb = conn.model(StoreKyb.name, StoreKybSchema); const audit = conn.model(KybAuditEvent.name, KybAuditEventSchema);
    const settings = conn.model(KybSettings.name, KybSettingsSchema); const store = conn.model(Store.name, StoreSchema);
    const svc = new KybMaintenanceService(kyb as any, settings as any, store as any, new KybAuditService(audit as any), {} as any, new JobLeaseService(conn.model(JobLease.name, JobLeaseSchema) as any));
    const report = await svc.rotateKeys({ dryRun: process.argv.includes('--dry-run') });
    console.log(JSON.stringify(report, null, 2));
    if (report.failed > 0) process.exitCode = 1;
  } finally { await conn.close(); }
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
