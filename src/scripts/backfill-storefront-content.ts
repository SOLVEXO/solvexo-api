/**
 * One-time backfill for stores created before the sections+blocks storefront
 * builder (`store-theme`/`store-pages` modules) existed. New stores get their
 * `StoreTheme` + home `StorePage` eagerly created inside
 * `StoreService.createStore()`; this script does the same for every
 * pre-existing store, best-effort seeding `StoreTheme.theme` colors from the
 * old `Store.builderConfig` blob where present (that field is left in place,
 * untouched, as an inert orphan — not deleted or otherwise migrated).
 *
 * Usage: npx ts-node src/scripts/backfill-storefront-content.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const stores = db.collection('stores');
  const storeThemes = db.collection('storethemes');
  const storePages = db.collection('storepages');

  const cursor = stores.find({ isDelete: { $ne: true } }, { projection: { _id: 1, builderConfig: 1 } });

  let themesCreated = 0;
  let pagesCreated = 0;

  for await (const store of cursor) {
    const storeId = store._id.toString();
    const cfg = (store.builderConfig ?? {}) as Record<string, any>;

    const existingTheme = await storeThemes.findOne({ storeId });
    if (!existingTheme) {
      await storeThemes.insertOne({
        storeId,
        theme: {
          primaryColor: cfg.primaryColor ?? '#D97757',
          bgColor: cfg.bgColor ?? '#FAF9F5',
          textColor: cfg.textColor ?? '#2C2A28',
          accentColor: cfg.accentColor ?? '#B95A3A',
          font: cfg.font ?? 'Poppins',
        },
        header: { logoSource: 'store', customLogoUrl: null, blocks: [] },
        footer: { blocks: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      themesCreated++;
    }

    const existingHome = await storePages.findOne({ storeId, type: 'home' });
    if (!existingHome) {
      await storePages.insertOne({
        storeId,
        type: 'home',
        slug: '',
        title: 'Home',
        sections: [
          { type: 'hero', settings: { heightPreset: 'medium' }, blocks: [] },
          {
            type: 'product_catalog',
            settings: {
              heading: 'Our Products',
              defaultSort: cfg.sortOrder ?? 'newest',
              columns: [2, 3, 4].includes(cfg.columns) ? cfg.columns : 3,
            },
            blocks: [],
          },
        ],
        seo: { metaTitle: cfg.metaTitle ?? null, metaDesc: cfg.metaDesc ?? null },
        status: 'draft',
        showInNav: false,
        showInFooter: false,
        isDelete: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      pagesCreated++;
    }
  }

  console.log(`Created ${themesCreated} StoreTheme doc(s) and ${pagesCreated} home StorePage doc(s).`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
