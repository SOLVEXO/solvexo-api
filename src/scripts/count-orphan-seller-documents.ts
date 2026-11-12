/* eslint-disable no-console */
/**
 * READ-ONLY count of private SELLER verification documents in Cloudinary (folder `private/kyc-documents`), and — when a database is given —
 * how many of them nothing references any more (orphans). It prints COUNTS, BYTES and AGE BUCKETS only: no file names, no public ids, no URLs.
 * It never deletes, never writes.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/count-orphan-seller-documents.ts
 *        # reads ONLY the CLOUDINARY_* keys from ./.env → how many private seller documents exist in the account
 *   npx ts-node -r tsconfig-paths/register src/scripts/count-orphan-seller-documents.ts --mongo-uri "<uri>"
 *        # ALSO reads store.verification.documents.publicId (read-only find) → how many are referenced / orphaned
 *
 * The database is only touched when YOU pass --mongo-uri (or COUNT_MONGO_URI); the script does not read MONGO_URI from .env.
 */
import { readFileSync } from 'fs';
import { parse } from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import { MongoClient } from 'mongodb';

const PREFIX = 'private/kyc-documents';
const DAY = 86_400_000;

async function listAll(): Promise<Array<{ id: string; bytes: number; created: number }>> {
  const out: Array<{ id: string; bytes: number; created: number }> = [];
  for (const resource_type of ['raw', 'image', 'video'] as const) {
    let next: string | undefined;
    do {
      const r: any = await cloudinary.api.resources({ type: 'private', resource_type, prefix: PREFIX, max_results: 500, next_cursor: next });
      for (const x of r.resources ?? []) out.push({ id: x.public_id, bytes: Number(x.bytes) || 0, created: new Date(x.created_at).getTime() });
      next = r.next_cursor;
    } while (next);
  }
  return out;
}

const buckets = (rows: Array<{ bytes: number; created: number }>) => {
  const now = Date.now();
  const b = { 'under 30 days': { n: 0, bytes: 0 }, '30–90 days': { n: 0, bytes: 0 }, 'over 90 days': { n: 0, bytes: 0 } };
  for (const r of rows) {
    const k = now - r.created < 30 * DAY ? 'under 30 days' : now - r.created < 90 * DAY ? '30–90 days' : 'over 90 days';
    b[k].n++; b[k].bytes += r.bytes;
  }
  return b;
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  const env = parse(readFileSync('.env'));
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) { console.error('CLOUDINARY_* keys are not all set in .env'); process.exit(1); }
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
  const assets = await listAll();
  console.log(`Private seller verification documents in Cloudinary (${PREFIX}/…): ${assets.length} file(s), ${mb(assets.reduce((s, a) => s + a.bytes, 0))}`);
  for (const [k, v] of Object.entries(buckets(assets))) console.log(`  ${k}: ${v.n} (${mb(v.bytes)})`);

  const uri = (process.argv.includes('--mongo-uri') ? process.argv[process.argv.indexOf('--mongo-uri') + 1] : undefined) ?? process.env.COUNT_MONGO_URI;
  if (!uri) { console.log('\nNo database given: orphans NOT counted. Re-run with --mongo-uri "<read-only uri>" to compare against store.verification.documents.'); return; }
  const client = new MongoClient(uri, { readPreference: 'secondaryPreferred' });
  await client.connect();
  try {
    const referenced = new Set<string>();
    const cur = client.db().collection('stores').find({ 'verification.documents.0': { $exists: true } }, { projection: { 'verification.documents.publicId': 1 } });
    for await (const s of cur) for (const d of (s as any).verification?.documents ?? []) if (d?.publicId) referenced.add(String(d.publicId));
    const orphans = assets.filter((a) => !referenced.has(a.id));
    console.log(`\nReferenced by a store: ${assets.length - orphans.length}   ORPHANS (nothing references them): ${orphans.length} (${mb(orphans.reduce((s, a) => s + a.bytes, 0))})`);
    for (const [k, v] of Object.entries(buckets(orphans))) console.log(`  orphans ${k}: ${v.n} (${mb(v.bytes)})`);
    console.log('Nothing was deleted. (A referenced id that is missing from Cloudinary is not counted here.)');
  } finally {
    await client.close();
  }
}
main().catch((e) => { console.error('count failed:', e?.message ?? e); process.exit(1); });
