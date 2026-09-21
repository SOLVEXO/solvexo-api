/**
 * One-time repair for `StoreTheme.themeDefinitionId`/`baseThemeId` corruption
 * (see `store-theme.schema.ts`'s own doc comment on `themeDefinitionId`,
 * lines ~224-238): `themeDefinitionId` must always be a code-registry key
 * (`'theme-01-atelier'` | `'theme-02-nova'` — see
 * `storefront-themes/registry.ts` on the frontend), never a Mongo
 * `ThemeDefinition` catalog `_id`. A prior version of
 * `StoreThemeService.applyThemeDefinition` collided the two, writing a raw
 * catalog ObjectId into this field on some already-existing documents before
 * that code path was fixed to use `appliedCatalogThemeId` instead. Those
 * documents were never repaired — found live during Phase 11 QA (a
 * `themeDefinitionId` holding a raw ObjectId broke Draft/Share Preview,
 * which looks the value up in the frontend's code registry and silently
 * falls back to "no preview available" for anything it doesn't recognize).
 *
 * This script only ever REPAIRS an invalid value — it never touches a
 * document whose `themeDefinitionId`/`baseThemeId` is already one of the
 * two known-valid registry keys (or `null`, the legitimate "not yet
 * backfilled" state `ensureDefaultTheme` already handles on its own). An
 * invalid value (anything else — typically a 24-hex ObjectId) is replaced
 * with `DEFAULT_THEME_DEFINITION_ID`, the exact same fallback the frontend
 * registry itself already applies at render time for an unrecognized id
 * (`registry.ts`: "a map doesn't cover falls back to DEFAULT_THEME_ID") —
 * so this migration makes explicit/persisted what unrecognized-id handling
 * already does implicitly, rather than guessing which theme a corrupted row
 * "should" be.
 *
 * Idempotent — safe to run more than once (a second run finds nothing left
 * to repair).
 *
 * Usage: npx ts-node src/scripts/migrate-fix-theme-definition-id.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const DEFAULT_THEME_DEFINITION_ID = 'theme-01-atelier';
const VALID_THEME_DEFINITION_IDS = new Set(['theme-01-atelier', 'theme-02-nova']);

function isInvalid(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && !VALID_THEME_DEFINITION_IDS.has(value);
}

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const storeThemes = db.collection('storethemes');
  const docs = await storeThemes
    .find({}, { projection: { themeDefinitionId: 1, baseThemeId: 1, draft: 1 } })
    .toArray();

  let repaired = 0;
  for (const doc of docs) {
    const set: Record<string, string> = {};
    if (isInvalid(doc.themeDefinitionId)) set.themeDefinitionId = DEFAULT_THEME_DEFINITION_ID;
    if (isInvalid(doc.baseThemeId)) set.baseThemeId = DEFAULT_THEME_DEFINITION_ID;
    if (isInvalid(doc.draft?.themeDefinitionId)) set['draft.themeDefinitionId'] = DEFAULT_THEME_DEFINITION_ID;
    if (isInvalid(doc.draft?.baseThemeId)) set['draft.baseThemeId'] = DEFAULT_THEME_DEFINITION_ID;

    if (Object.keys(set).length > 0) {
      await storeThemes.updateOne({ _id: doc._id }, { $set: set });
      repaired += 1;
      console.log(`Repaired storeId=${doc.storeId ?? doc._id}:`, set);
    }
  }

  console.log(`Done. Repaired ${repaired} of ${docs.length} store-theme document(s). Already-valid documents were left untouched.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
