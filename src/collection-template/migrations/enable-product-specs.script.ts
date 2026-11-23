/* eslint-disable prettier/prettier */
/**
 * One-time: switch the product page's "Specifications" block ON in every store where it is OFF (live and draft).
 *
 * Why: the block was seeded OFF, so specs a seller typed on a product never showed. New stores now start with it ON;
 * this brings the older ones in line. It cannot tell "seeded OFF" from "the seller switched it OFF on purpose", so it
 * turns both ON (a product without specs draws nothing, so this is harmless to stores that did not want it).
 *
 * It only touches `product_specs` blocks that are exactly `enabled: false`. Run it first WITHOUT --apply: it only counts.
 *
 *   count only : node --env-file=.env -r ts-node/register -r tsconfig-paths/register src/collection-template/migrations/enable-product-specs.script.ts
 *   do it      : ... enable-product-specs.script.ts --apply
 */
import mongoose from 'mongoose';
import { CollectionTemplate, CollectionTemplateSchema } from '../schemas/collection-template.schema';

type Where = 'sections' | 'draft.sections';

/** Templates whose product_main has a product_specs block switched off, in the given list (live or draft). */
const offFilter = (where: Where) => ({
  resourceType: 'product',
  [where]: { $elemMatch: { type: 'product_main', blocks: { $elemMatch: { type: 'product_specs', enabled: false } } } },
});

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set');
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri);
  const Model = mongoose.models[CollectionTemplate.name] ?? mongoose.model(CollectionTemplate.name, CollectionTemplateSchema);

  for (const where of ['sections', 'draft.sections'] as Where[]) {
    const label = where === 'sections' ? 'live' : 'draft';
    const n = await Model.countDocuments(offFilter(where));
    if (!apply) { console.log(`[count only] ${n} product template(s) have Specifications OFF in ${label}.`); continue; }
    const res = await Model.updateMany(offFilter(where), { $set: { [`${where}.$[m].blocks.$[b].enabled`]: true } }, {
      arrayFilters: [{ 'm.type': 'product_main' }, { 'b.type': 'product_specs', 'b.enabled': false }],
    });
    console.log(`Switched Specifications ON in ${res.modifiedCount} product template(s) (${label}).`);
  }
  if (!apply) console.log('Nothing was changed. Add --apply to switch them on.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Enable-specs migration failed:', err);
  process.exit(1);
});
