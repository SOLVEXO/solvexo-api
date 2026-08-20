/**
 * One-time, idempotent backfill: copies `StorePage.seo.metaDesc` into the new
 * `seo.metaDescription` field for every existing page where `metaDescription`
 * is still empty and `metaDesc` has a real value (Phase 6 SEO parity — see
 * CLAUDE.md's "Store Pages" section). Safe to re-run: the query itself
 * excludes any document that already has `metaDescription` set, so a second
 * run always matches zero documents.
 *
 * Run with: npx ts-node scripts/backfill-store-page-seo.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');
  await mongoose.connect(uri);

  const StorePage = mongoose.connection.collection('storepages');
  const result = await StorePage.updateMany(
    {
      'seo.metaDesc': { $exists: true, $nin: [null, ''] },
      $or: [{ 'seo.metaDescription': { $exists: false } }, { 'seo.metaDescription': null }, { 'seo.metaDescription': '' }],
    },
    [{ $set: { 'seo.metaDescription': '$seo.metaDesc' } }],
  );

  console.log(`Backfilled seo.metaDescription on ${result.modifiedCount} StorePage document(s).`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
