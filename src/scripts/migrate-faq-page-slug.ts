/**
 * Gives every seller-built FAQ page the slug 'faqs', so the storefront's /faqs shows it.
 *
 * 'faqs' used to be a reserved slug, so a page titled "FAQ"/"FAQs" ended up at 'faq' (or 'faqs-2'). The reserved slug is gone
 * and /faqs now serves a published page with that slug first. Only custom pages whose TITLE is exactly FAQ/FAQs and whose slug
 * is 'faq' / 'faqs-2' are touched, and only when the store has no page at 'faqs' already. The saved draft/live sections are
 * not changed, only the slug.
 *
 * Safe by default: it only REPORTS what it would change. Pass `--apply` to write. Idempotent.
 *
 * Usage (dry run):  npx ts-node src/scripts/migrate-faq-page-slug.ts
 *       (write):    npx ts-node src/scripts/migrate-faq-page-slug.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const OLD_SLUGS = ['faq', 'faqs-2'];
const TARGET = 'faqs';

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

  const pages = db.collection('storepages');
  const candidates = await pages
    .find({ type: 'custom', isDelete: false, slug: { $in: OLD_SLUGS }, title: { $regex: /^\s*faqs?\s*$/i } }, { projection: { storeId: 1, slug: 1, title: 1, status: 1 } })
    .toArray();

  let changed = 0;
  let skipped = 0;
  for (const page of candidates) {
    const clash = await pages.findOne({ storeId: page.storeId, slug: TARGET, isDelete: false, _id: { $ne: page._id } }, { projection: { _id: 1 } });
    if (clash) {
      skipped += 1;
      console.log(`Skip storeId=${page.storeId} page=${page._id}: the store already has a page at '${TARGET}'`);
      continue;
    }
    console.log(`${apply ? 'Renaming' : 'Would rename'} storeId=${page.storeId} page=${page._id} (${page.status}) '${page.slug}' -> '${TARGET}'`);
    if (apply) await pages.updateOne({ _id: page._id }, { $set: { slug: TARGET } });
    changed += 1;
  }

  console.log(`\n${apply ? 'Renamed' : 'Would rename'} ${changed} page(s); skipped ${skipped}.`);
  if (!apply) console.log('Dry run only: nothing was written. Re-run with --apply to migrate.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
