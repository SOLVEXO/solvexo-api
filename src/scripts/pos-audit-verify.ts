/* eslint-disable no-console */
/**
 * G4.3 — verify the nightly audit seals of a store (read-only). Exits 1 if any day changed or the chain is broken.
 *   MONGO_URI=… npx ts-node -r tsconfig-paths/register src/scripts/pos-audit-verify.ts <storeId> [fromDay] [toDay]
 */
import mongoose from 'mongoose';
import * as schema from '@/database/schema';
import { PosAuditSealService, SEALED_COLLECTIONS } from '../pos/pos-audit-seal.service';

async function main() {
  const [storeId, from, to] = process.argv.slice(2);
  const uri = process.env.MONGO_URI;
  if (!uri || !storeId) { console.error('Usage: MONGO_URI=… pos-audit-verify.ts <storeId> [fromDay YYYY-MM-DD] [toDay]'); process.exit(2); }
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    const names: Record<string, string> = { posAuditLogModel: 'PosAuditLog', posPaymentModel: 'PosPayment', posRefundModel: 'PosRefund', posCreditNoteModel: 'PosCreditNote', stockMovementModel: 'StockMovement', storeCreditEntryModel: 'StoreCreditEntry', supplierLedgerEntryModel: 'SupplierLedgerEntry', purchaseReceiptModel: 'PurchaseReceipt', posExpenseModel: 'PosExpense', posExpenseEventModel: 'PosExpenseEvent', posAttendanceEventModel: 'PosAttendanceEvent' };
    const repos: any = { posAuditSealModel: conn.model(schema.PosAuditSeal.name, schema.PosAuditSealSchema), storeModel: conn.model(schema.Store.name, schema.StoreSchema) };
    for (const repo of Object.keys(SEALED_COLLECTIONS)) { const n = names[repo]; repos[repo] = conn.model(n, (schema as any)[`${n}Schema`]); }
    const svc = new PosAuditSealService({ repositories: repos } as any, {} as any);
    const r = await svc.verify(storeId, from, to);
    for (const d of r.results) console.log(`${d.day}  ${d.status.padEnd(12)} ${d.count} record(s)${d.changedParts.length ? '  changed: ' + d.changedParts.map((p: any) => `${p.part} (${p.sealedCount} → ${p.nowCount})`).join(', ') : ''}`);
    console.log(r.ok ? `OK — ${r.days} sealed day(s) verified` : 'FAILED — see the lines above');
    process.exit(r.ok ? 0 : 1);
  } finally { await conn.close(); }
}
main().catch((e) => { console.error(e); process.exit(2); });
