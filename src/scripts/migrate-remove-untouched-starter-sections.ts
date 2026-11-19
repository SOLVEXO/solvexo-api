/**
 * Removes the OLD auto-added starter sections from home pages the seller never touched.
 * Shopify rule: nothing on a storefront that the seller did not choose. New stores no longer get these
 * (see `starterHomeSections()`); this cleans stores created before that change.
 *
 * Only a section that is EXACTLY what the old starter created is removed (same type, same settings, same blocks,
 * no extra keys). Anything the seller edited in any way (text, design, source, blocks) is kept.
 * Covers live + draft sections, in the page and in every theme template slot.
 *
 * Usage (dry run, prints what would change):  npx ts-node src/scripts/migrate-remove-untouched-starter-sections.ts
 *       (really change the data):             npx ts-node src/scripts/migrate-remove-untouched-starter-sections.ts --apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { isDeepStrictEqual } from 'node:util';

const trustBlocks = [
  { type: 'trust_badge_item', settings: { icon: 'lock', text: 'Secure checkout' } },
  { type: 'trust_badge_item', settings: { icon: 'shield', text: 'Quality you can trust' } },
  { type: 'trust_badge_item', settings: { icon: 'headset', text: 'Friendly support' } },
];
const OLD_STARTER: Array<{ type: string; settings: Record<string, unknown>; blocks: unknown[] }> = [
  { type: 'trust_badges', settings: {}, blocks: trustBlocks },
  { type: 'featured_products', settings: { heading: 'New arrivals', source: 'newArrivals', limit: 8, columns: 4 }, blocks: [] },
  { type: 'featured_products', settings: { heading: 'Best sellers', source: 'bestsellers', limit: 4, columns: 4 }, blocks: [] },
  { type: 'newsletter', settings: { heading: 'Stay in the loop', subtext: 'Be first to hear about new arrivals and offers.' }, blocks: [] },
];

/** Strip the identifying fields Mongoose/the editor add (ids) so only the seller-visible content is compared. */
function plain(section: any) {
  return { type: section?.type, settings: section?.settings ?? {}, blocks: (section?.blocks ?? []).map((b: any) => ({ type: b?.type, settings: b?.settings ?? {} })) };
}
const isUntouchedStarter = (section: any) => OLD_STARTER.some(s => isDeepStrictEqual(plain(section), s));

function clean(list: unknown): { next: any[]; removed: number } {
  const arr = Array.isArray(list) ? list : [];
  const next = arr.filter(s => !isUntouchedStarter(s));
  return { next, removed: arr.length - next.length };
}

async function run() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');
  const pages = db.collection('storepages');
  let touchedPages = 0;
  let removedTotal = 0;

  for await (const page of pages.find({ type: 'home', isDelete: { $ne: true } })) {
    const set: Record<string, unknown> = {};
    let removed = 0;
    const live = clean(page.sections); if (live.removed) { set.sections = live.next; removed += live.removed; }
    const draft = clean(page.draft?.sections); if (draft.removed) { set['draft.sections'] = draft.next; removed += draft.removed; }
    (page.themeTemplates ?? []).forEach((t: any, i: number) => {
      const l = clean(t.sections); if (l.removed) { set[`themeTemplates.${i}.sections`] = l.next; removed += l.removed; }
      const d = clean(t.draftSections); if (d.removed) { set[`themeTemplates.${i}.draftSections`] = d.next; removed += d.removed; }
    });
    if (!removed) continue;
    touchedPages++; removedTotal += removed;
    console.log(`${apply ? 'cleaning' : 'would clean'} store ${page.storeId}: ${removed} untouched starter section(s)`);
    if (apply) await pages.updateOne({ _id: page._id }, { $set: set });
  }
  console.log(`${apply ? 'Done' : 'Dry run'}: ${removedTotal} section(s) in ${touchedPages} home page(s).${apply ? '' : ' Re-run with --apply to change the data.'}`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
