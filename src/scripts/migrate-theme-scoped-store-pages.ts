/**
 * Copies legacy store-page layouts, drafts, and version history into the
 * active installed theme's template slot. Safe to re-run: existing slots
 * are preserved and only missing slots are backfilled.
 *
 * Usage: npx ts-node src/scripts/migrate-theme-scoped-store-pages.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const pagesExists = await db.listCollections({ name: 'storepages' }).hasNext();
  if (!pagesExists) {
    console.log('storepages collection does not exist — nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  const pages = db.collection('storepages');
  const themes = db.collection('storethemes');
  const stores = await pages.distinct('storeId');
  let migrated = 0;

  for (const storeId of stores) {
    const active = await themes.findOne(
      { storeId, status: 'active' },
      { projection: { _id: 1, themeDefinitionId: 1 } },
    );
    if (!active) {
      throw new Error(`Store ${storeId} has pages but no active installed theme; migration stopped.`);
    }
    if (!active.themeDefinitionId) {
      throw new Error(`Active theme ${active._id} for store ${storeId} has no themeDefinitionId; migration stopped.`);
    }

    const cursor = pages.find({
      storeId,
      themeTemplates: { $not: { $elemMatch: { installedThemeId: String(active._id) } } },
    });
    for await (const page of cursor) {
      const legacyLive = Array.isArray(page.sections) ? page.sections : [];
      const legacyDraft = Array.isArray(page.draft?.sections) ? page.draft.sections : legacyLive;
      const layout = {
        installedThemeId: String(active._id),
        sections: legacyLive,
        draftSections: legacyDraft,
        lastPublishedAt: page.lastPublishedAt ?? null,
        versions: Array.isArray(page.versions) ? page.versions : [],
      };
      const result = await pages.updateOne(
        {
          _id: page._id,
          themeTemplates: { $not: { $elemMatch: { installedThemeId: String(active._id) } } },
        },
        { $push: { themeTemplates: layout } } as any,
      );
      migrated += result.modifiedCount;
    }
  }

  console.log(`Backfilled ${migrated} store page(s) into their active installed theme.`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
