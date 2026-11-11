/**
 * Removes what the retired AI Studio left in the database:
 *   - the two collections it used (`aigenerations`, `aicredittransactions`: every generation and every credit hold/refund row)
 *   - the tool names `ai_studio` / `ai_worksheet_builder` from every store's `enabledTools`
 *   - the activity-log rows with category `ai_studio`
 *
 * It does NOT touch the AI credits wallets (`aicreditswallets`): AI SEO suggestions still spend them.
 *
 * Safe by default: it only REPORTS what it would remove. Pass `--apply` to delete. Idempotent. TAKE A BACKUP FIRST: deleted rows are gone.
 *
 * Usage (dry run):  npx ts-node src/scripts/remove-ai-studio-data.ts
 *       (delete):   npx ts-node src/scripts/remove-ai-studio-data.ts --apply
 */
import 'dotenv/config';

export const AI_STUDIO_COLLECTIONS = ['aigenerations', 'aicredittransactions'];
export const AI_STUDIO_TOOLS = ['ai_studio', 'ai_worksheet_builder'];
export const AI_STUDIO_LOG_CATEGORY = 'ai_studio';

/** The few database calls the cleanup needs (the real `mongoose.connection.db` satisfies it). */
export interface CleanupDb {
  listCollections(): { toArray(): Promise<Array<{ name: string }>> };
  collection(name: string): {
    countDocuments(filter: Record<string, unknown>): Promise<number>;
    drop(): Promise<unknown>;
    updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
    deleteMany(filter: Record<string, unknown>): Promise<unknown>;
  };
}

export interface CleanupReport { collections: Record<string, number | null>; storesCleaned: number; logRows: number; applied: boolean }

export async function removeAiStudioData(db: CleanupDb, apply: boolean, log: (line: string) => void = () => undefined): Promise<CleanupReport> {
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const report: CleanupReport = { collections: {}, storesCleaned: 0, logRows: 0, applied: apply };
  log(apply ? 'APPLY mode: deleting.' : 'DRY RUN: nothing will be changed.');

  for (const name of AI_STUDIO_COLLECTIONS) {
    if (!existing.has(name)) {
      report.collections[name] = null;
      log(`- ${name}: not in this database`);
      continue;
    }
    const n = await db.collection(name).countDocuments({});
    report.collections[name] = n;
    log(`- ${name}: ${n} document(s) ${apply ? 'dropped' : 'would be dropped'}`);
    if (apply) await db.collection(name).drop();
  }

  if (existing.has('stores')) {
    const filter = { enabledTools: { $in: AI_STUDIO_TOOLS } };
    report.storesCleaned = await db.collection('stores').countDocuments(filter);
    log(`- stores.enabledTools: ${report.storesCleaned} store(s) ${apply ? 'cleaned' : 'would be cleaned'} (${AI_STUDIO_TOOLS.join(', ')})`);
    if (apply && report.storesCleaned > 0) await db.collection('stores').updateMany(filter, { $pull: { enabledTools: { $in: AI_STUDIO_TOOLS } } });
  }

  if (existing.has('activitylogs')) {
    report.logRows = await db.collection('activitylogs').countDocuments({ category: AI_STUDIO_LOG_CATEGORY });
    log(`- activitylogs (category ${AI_STUDIO_LOG_CATEGORY}): ${report.logRows} row(s) ${apply ? 'deleted' : 'would be deleted'}`);
    if (apply && report.logRows > 0) await db.collection('activitylogs').deleteMany({ category: AI_STUDIO_LOG_CATEGORY });
  }

  if (!apply) log('\nDry run only. Re-run with --apply (after a backup) to delete.');
  return report;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }
  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  await removeAiStudioData(db as unknown as CleanupDb, process.argv.includes('--apply'), console.log);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
