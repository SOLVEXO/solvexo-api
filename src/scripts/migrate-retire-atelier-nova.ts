/**
 * Moves every store theme row off the two retired themes ('theme-01-atelier', 'theme-02-nova') onto Maison
 * ('theme-03-fashion'), the single base theme.
 *
 * Only the code-registry key changes (`themeDefinitionId` / `baseThemeId`, root and draft). The seller's own
 * choices are left alone: colours, fonts, header/footer, menus, banners and every page/template section are
 * theme-neutral data that Maison reads as well. Rows already on another valid key are not touched.
 *
 * Safe by default: it only REPORTS what it would change. Pass `--apply` to write. Idempotent.
 *
 * Usage (dry run):  npx ts-node src/scripts/migrate-retire-atelier-nova.ts
 *       (write):    npx ts-node src/scripts/migrate-retire-atelier-nova.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const RETIRED = ['theme-01-atelier', 'theme-02-nova'];
const TARGET = 'theme-03-fashion';
const FIELDS = ['themeDefinitionId', 'baseThemeId', 'draft.themeDefinitionId', 'draft.baseThemeId'] as const;

const read = (doc: Record<string, any>, path: string) => path.split('.').reduce((o, k) => o?.[k], doc);

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const storeThemes = db.collection('storethemes');
  const filter = { $or: FIELDS.map((f) => ({ [f]: { $in: RETIRED } })) };
  const docs = await storeThemes
    .find(filter, { projection: { storeId: 1, status: 1, themeDefinitionId: 1, baseThemeId: 1, draft: 1 } })
    .toArray();

  const perTheme: Record<string, number> = {};
  const stores = new Set<string>();
  let changed = 0;
  for (const doc of docs) {
    const set: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = read(doc, f);
      if (typeof v === 'string' && RETIRED.includes(v)) set[f] = TARGET;
    }
    if (Object.keys(set).length === 0) continue;
    perTheme[String(doc.themeDefinitionId)] = (perTheme[String(doc.themeDefinitionId)] ?? 0) + 1;
    stores.add(String(doc.storeId));
    console.log(`${apply ? 'Moving' : 'Would move'} storeId=${doc.storeId} row=${doc._id} status=${doc.status}:`, set);
    if (apply) await storeThemes.updateOne({ _id: doc._id }, { $set: set });
    changed += 1;
  }

  console.log(`\n${apply ? 'Moved' : 'Would move'} ${changed} theme row(s) in ${stores.size} store(s) to ${TARGET}. By previous theme:`, perTheme);
  if (!apply) console.log('Dry run only: nothing was written. Re-run with --apply to migrate.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
