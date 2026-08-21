/**
 * One-off verification (not part of the seed pipeline) — the seed script
 * writes via the native MongoDB driver for simplicity, which means it never
 * actually runs the seeded `homePageSections` through the real
 * `validateSectionSettings`/`validateBlockSettings`/`SECTION_ALLOWED_BLOCK_TYPES`
 * the live API enforces on every seller-authored edit. This re-checks every
 * stored theme against those exact functions so a hand-authoring mistake
 * can't silently reach a seller's store un-validated.
 *
 * Usage: npx ts-node src/scripts/verify-theme-catalog.ts
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import {
  validateSectionSettings,
  validateBlockSettings,
  SECTION_ALLOWED_BLOCK_TYPES,
} from '../common/store-content/section-settings.validator';
import type { SectionType } from '../common/schemas/section.schema';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Failed to obtain DB connection');

  const docs = await db.collection('themedefinitions').find({}).toArray();
  let errors = 0;

  for (const doc of docs) {
    const sections = (doc.homePageSections ?? []) as any[];
    for (const [i, section] of sections.entries()) {
      const where = `${doc.slug} [section ${i}: ${section.type}]`;
      try {
        validateSectionSettings(
          section.type as SectionType,
          section.settings ?? {},
        );
      } catch (err) {
        console.error(`FAIL ${where} settings: ${(err as Error).message}`);
        errors++;
      }
      const allowed =
        SECTION_ALLOWED_BLOCK_TYPES[section.type as SectionType] ?? [];
      for (const [j, block] of (section.blocks ?? []).entries()) {
        const blockWhere = `${where} [block ${j}: ${block.type}]`;
        if (allowed.length > 0 && !allowed.includes(block.type)) {
          console.error(
            `FAIL ${blockWhere}: block type not allowed in this section (allowed: ${allowed.join(', ')})`,
          );
          errors++;
          continue;
        }
        try {
          validateBlockSettings(block.type, block.settings ?? {});
        } catch (err) {
          console.error(`FAIL ${blockWhere}: ${(err as Error).message}`);
          errors++;
        }
      }
    }
  }

  console.log(
    `Checked ${docs.length} themes. ${errors === 0 ? 'All valid.' : `${errors} error(s) found.`}`,
  );
  await mongoose.disconnect();
  process.exit(errors === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
