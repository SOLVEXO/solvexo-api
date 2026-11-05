/* eslint-disable no-console */
/**
 * Real-storage check for KYB documents (Cloudinary, the project's existing storage). Uploads a tiny throw-away PDF to
 * `private/kyb/_storage-check/…`, exercises view + download, proves the link EXPIRES, and deletes the file. Prints no secret and no URL.
 *
 *   npx ts-node -r tsconfig-paths/register src/scripts/kyb-storage-check.ts            # reads ONLY the CLOUDINARY_* keys from ./.env
 *
 * Does not read MONGO_URI or any other variable from .env, and never touches a database.
 */
import { readFileSync } from 'fs';
import { parse } from 'dotenv';
import { UploadService } from '../upload/upload.service';

const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string): never => { console.error(`  FAIL ${m}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = parse(readFileSync('.env'));
  const cfg = { get: (k: string) => (k.startsWith('CLOUDINARY_') ? env[k] : undefined) } as any;
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) bad('CLOUDINARY_* keys are not all set in .env');
  const up = new UploadService(cfg);
  const body = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nKYB storage check ' + Date.now());
  const file = { originalname: 'kyb-storage-check.pdf', mimetype: 'application/pdf', size: body.length, buffer: body } as Express.Multer.File;

  const res = await up.uploadPrivateFile(file, 'private/kyb/_storage-check');
  ok(`uploaded a private document (folder ${res.publicId.split('/').slice(0, 3).join('/')}/…, resource_type ${res.resourceType})`);
  try {
    if (!res.publicId.startsWith('private/kyb/')) bad('document is not under the private KYB folder');

    // 1) the download path we use for admin "download": server-side fetch of the bytes
    const bytes = await up.downloadPrivateFileBuffer(res.publicId, res.resourceType);
    if (!bytes.equals(body)) bad('downloaded bytes differ from the uploaded bytes');
    ok('server-side download returns the exact bytes');

    // 2) a PUBLIC (unsigned) delivery URL must not work for a private asset
    const cloud = env.CLOUDINARY_CLOUD_NAME;
    const pub = await fetch(`https://res.cloudinary.com/${cloud}/${res.resourceType}/upload/${res.publicId}`);
    if (pub.status === 200) bad('the document is publicly readable');
    ok(`the public (unsigned) URL does not serve it (HTTP ${pub.status})`);

    // 3) the expiring view / download URLs: valid now, dead after their lifetime (6 s in this check; production uses 300 s, hard ceiling 300 s)
    const view = up.generateExpiringPrivateUrl(res.publicId, res.resourceType, 6, { inline: true });
    const dl = up.generateExpiringPrivateUrl(res.publicId, res.resourceType, 6, { fileName: 'x.pdf' });
    for (const [label, u] of [['view (inline)', view], ['download (attachment)', dl]] as const) {
      const r = await fetch(u); if (r.status !== 200) bad(`${label} URL did not work immediately (HTTP ${r.status})`);
      if (!Buffer.from(await r.arrayBuffer()).equals(body)) bad(`${label} URL returned different bytes`);
    }
    ok('view and download URLs work right after they are issued and return the exact bytes');
    const long = new URL(up.generateExpiringPrivateUrl(res.publicId, res.resourceType, 99999, { inline: true }));
    const life = Number(long.searchParams.get('expires_at')) - Math.floor(Date.now() / 1000);
    if (!(life > 0 && life <= 300)) bad(`requested 99999 s but the URL lifetime is ${life} s (ceiling is 300 s)`);
    ok(`lifetime is capped: asked for 99999 s, got ${life} s (≤ 300)`);
    await sleep(12_000);
    for (const [label, u] of [['view (inline)', view], ['download (attachment)', dl]] as const) {
      const r = await fetch(u); if (r.status === 200) bad(`the ${label} URL STILL WORKS after its lifetime`);
      ok(`the ${label} URL stops working after its lifetime (HTTP ${r.status})`);
    }
  } finally {
    const del = await up.deletePrivateFile(res.publicId, res.resourceType);
    const gone = await up.downloadPrivateFileBuffer(res.publicId, res.resourceType).then(() => false, () => true);
    if (!gone) bad(`the test document could not be deleted (${del})`); else ok(`test document deleted (${del})`);
  }
  console.log('STORAGE CHECK OK');
}
main().catch((e) => { console.error('STORAGE CHECK FAILED:', e?.message ?? e); process.exit(1); });
