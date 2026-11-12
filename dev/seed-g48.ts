/* eslint-disable */
/**
 * DEV ONLY — G4.8 real-backend coverage data for the local dev stack (called by dev/seed.ts):
 *   · a supplier ("Dev Bakery Supplier") set on the low-stock croissant, so low stock → Draft PO goes down the "draft created" path;
 *   · at least one PAST store day with records, sealed by the real nightly sealing code (PosAuditSealService.sealStore), so the app's integrity check
 *     compares real seals end to end;
 *   · `--tamper-seal` / `--untamper-seal`: edit one record of the latest sealed day directly in Mongo (the deliberate mismatch the app must show),
 *     then put it back exactly. The original is kept in dev/.run/tamper.json. Never against anything but the dev database (seed.ts refuses otherwise).
 */
import * as fs from 'fs';
import * as path from 'path';

const schema = require('../dist/database/schema');
const { PosAuditSealService, SEALED_COLLECTIONS } = require('../dist/pos/pos-audit-seal.service');

const DAY = 86_400_000;
const TAMPER_FILE = path.join(__dirname, '.run', 'tamper.json');

/** The real sealing service over this connection (the same models the verify CLI uses). */
function sealService(conn: any) {
  const names: Record<string, string> = {
    posAuditLogModel: 'PosAuditLog', posPaymentModel: 'PosPayment', posRefundModel: 'PosRefund', posCreditNoteModel: 'PosCreditNote', stockMovementModel: 'StockMovement',
    storeCreditEntryModel: 'StoreCreditEntry', supplierLedgerEntryModel: 'SupplierLedgerEntry', purchaseReceiptModel: 'PurchaseReceipt', posExpenseModel: 'PosExpense',
    posExpenseEventModel: 'PosExpenseEvent', posAttendanceEventModel: 'PosAttendanceEvent',
  };
  const model = (n: string) => conn.models[n] ?? conn.model(n, schema[`${n}Schema`]);
  const repos: any = { posAuditSealModel: model('PosAuditSeal'), storeModel: model('Store'), posSettingsModel: model('PosSettings') };
  for (const repo of Object.keys(SEALED_COLLECTIONS)) repos[repo] = model(names[repo]);
  return new PosAuditSealService({ repositories: repos }, {});
}

export async function seedG48(conn: any, storeId: string, sellerId: string) {
  const db = conn.db!;
  // 1 · low stock for one supplier: the croissant (stock 2, reorder point 5) is bought from "Dev Bakery Supplier"
  const sup = await db.collection('suppliers').findOneAndUpdate(
    { storeId, name: 'Dev Bakery Supplier' },
    { $set: { storeId, sellerId, name: 'Dev Bakery Supplier', status: 'active', isDelete: false, leadTimeDays: 2, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  const supplierId = String((sup as any)?._id ?? (sup as any)?.value?._id);
  const croissant: any = await db.collection('products').findOne({ storeId, name: 'Dev Croissant (low stock)' });
  if (croissant) {
    await db.collection('products').updateOne({ _id: croissant._id }, { $set: { supplierId } });
    await db.collection('productvariants').updateOne({ productId: String(croissant._id), sku: 'DEV-CROISSANT' }, { $set: { stock: 2, reorderPoint: 5, costPrice: 1.5, costPriceMinor: 150 } });
  }

  // 2 · a past store day with records, then the real nightly sealing for every closed day
  const twoDaysAgo = new Date(Date.now() - 2 * DAY);
  const have = await db.collection('posauditlogs').countDocuments({ storeId, action: 'dev_seed_marker', createdAt: { $gte: new Date(twoDaysAgo.getTime() - DAY / 2), $lt: new Date(twoDaysAgo.getTime() + DAY / 2) } });
  if (!have) {
    await db.collection('posauditlogs').insertOne({ storeId, employeeId: null, action: 'dev_seed_marker', targetId: storeId, targetType: 'store', metadata: { note: 'G4.8 seed: a record on a past day for the integrity check' }, createdAt: twoDaysAgo, updatedAt: twoDaysAgo });
  }
  const sealed: string[] = await sealService(conn).sealStore(storeId, new Date());
  const last: any = await db.collection('posauditseals').find({ storeId }).sort({ day: -1 }).limit(1).next();
  return { supplierId, sealedNow: sealed, lastSealedDay: last?.day ?? null };
}

/** Edits one record of the latest sealed day (the app's integrity check must report the day as changed). */
export async function tamperSeal(conn: any, storeId: string) {
  const db = conn.db!;
  const seal: any = await db.collection('posauditseals').find({ storeId }).sort({ day: -1 }).limit(1).next();
  if (!seal) throw new Error('No sealed day — run the seed first');
  const row: any = await db.collection('posauditlogs').findOne({ storeId, createdAt: { $gte: seal.from, $lt: seal.to } });
  if (!row) throw new Error(`No activity-log record on ${seal.day}`);
  fs.mkdirSync(path.dirname(TAMPER_FILE), { recursive: true });
  fs.writeFileSync(TAMPER_FILE, JSON.stringify({ id: String(row._id), metadata: row.metadata ?? null, day: seal.day }));
  await db.collection('posauditlogs').updateOne({ _id: row._id }, { $set: { metadata: { ...(row.metadata ?? {}), tampered: 'dev e2e: this record was changed after the day was sealed' } } });
  return { day: seal.day, recordId: String(row._id) };
}

/** Puts the tampered record back exactly as it was. */
export async function untamperSeal(conn: any) {
  if (!fs.existsSync(TAMPER_FILE)) return { restored: false };
  const t = JSON.parse(fs.readFileSync(TAMPER_FILE, 'utf8'));
  const { Types } = require('mongoose');
  await conn.db!.collection('posauditlogs').updateOne({ _id: new Types.ObjectId(t.id) }, t.metadata === null ? { $unset: { metadata: '' } } : { $set: { metadata: t.metadata } });
  fs.unlinkSync(TAMPER_FILE);
  return { restored: true, day: t.day };
}
