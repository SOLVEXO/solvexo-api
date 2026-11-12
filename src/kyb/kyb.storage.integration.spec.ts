/* eslint-disable prettier/prettier */
import { readFileSync } from 'fs';
import { parse } from 'dotenv';
import { Logger } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { UploadService } from '../upload/upload.service';
import { makePaymentsFixture, setKybKeys } from '../payments-core/testing/payments-harness';

/**
 * KYB documents against the REAL storage (Cloudinary — the account in ./.env, only the CLOUDINARY_* keys are read). Runs only with
 * `KYB_REAL_STORAGE=true` (it makes network calls and needs credentials): `KYB_REAL_STORAGE=true npx jest src/kyb/kyb.storage.integration.spec.ts`.
 * Every file it creates is deleted. The database is the usual throw-away test database, never the one in .env.
 */
const run = process.env.KYB_REAL_STORAGE === 'true' ? describe : describe.skip;
jest.setTimeout(180_000);

run('KYB documents on real storage', () => {
  it('upload → admin view URL → download → replace → remove → purge, with short-lived links that never reach the logs', async () => {
    setKybKeys({ v1: true, current: '1' });
    const env = parse(readFileSync('.env'));
    const upload = new UploadService({ get: (k: string) => (k.startsWith('CLOUDINARY_') ? env[k] : undefined) } as any);
    const x = await makePaymentsFixture({ verified: false, upload });
    const { sellerId, storeId } = x.s;
    const logged: string[] = [];
    const sinks = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error'), jest.spyOn(console, 'info'), jest.spyOn(console, 'debug'),
      jest.spyOn(Logger.prototype, 'log'), jest.spyOn(Logger.prototype, 'warn'), jest.spyOn(Logger.prototype, 'error'), jest.spyOn(Logger.prototype, 'debug'), jest.spyOn(Logger.prototype, 'verbose')];
    sinks.forEach((s) => s.mockImplementation((...a: any[]) => { logged.push(a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')); }));
    // existence is asked of Cloudinary's admin API (a CDN may keep serving a previously fetched copy of a deleted file for a while)
    const exists = (d: { publicId: string; resourceType: string }) => cloudinary.api.resource(d.publicId, { resource_type: d.resourceType as any, type: 'private' }).then(() => true, (e: any) => (e?.error?.http_code === 404 || e?.http_code === 404 ? false : Promise.reject(e)));
    const created: Array<{ publicId: string; resourceType: string }> = [];
    try {
      const pdf = (name: string, text: string) => ({ originalname: name, mimetype: 'application/pdf', size: text.length, buffer: Buffer.from(`%PDF-1.4 ${text}`) }) as any;
      const body1 = `kyb real storage ${Date.now()} one`;
      const v1: any = await x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', pdf('cnic.pdf', body1));
      const raw1: any = await x.kybModel.findOne({ storeId }).lean();
      const d1 = raw1.documents[0]; created.push({ publicId: d1.publicId, resourceType: d1.resourceType });
      expect(d1.publicId).toMatch(new RegExp(`^private/kyb/${storeId}/`));
      expect(JSON.stringify(v1)).not.toContain(d1.publicId); // owner view has no storage id

      // admin VIEW: a link that works now, expires within 5 minutes, and is 401 afterwards
      const docId = String(d1._id);
      const view: any = await x.kybAdmin.documentUrl(storeId, docId, { type: 'admin', id: 'adm' });
      expect(view.expiresInSeconds).toBeLessThanOrEqual(300);
      const life = Number(new URL(view.url).searchParams.get('expires_at')) - Math.floor(Date.now() / 1000);
      expect(life).toBeGreaterThan(0); expect(life).toBeLessThanOrEqual(300);
      const got = await fetch(view.url);
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer()).toString()).toContain(body1);

      // admin DOWNLOAD through the server
      const dl: any = await x.kybAdmin.documentDownload(storeId, docId, { type: 'admin', id: 'adm' });
      expect(dl.buffer.toString()).toContain(body1);

      // REPLACE: the old asset is really gone, the new one is readable
      const body2 = `kyb real storage ${Date.now()} two`;
      await x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', pdf('cnic2.pdf', body2));
      const raw2: any = await x.kybModel.findOne({ storeId }).lean();
      const d2 = raw2.documents[0]; created.push({ publicId: d2.publicId, resourceType: d2.resourceType });
      expect(d2.publicId).not.toBe(d1.publicId);
      expect(await exists(d1)).toBe(false);
      expect(await exists(d2)).toBe(true);
      expect((await upload.downloadPrivateFileBuffer(d2.publicId, d2.resourceType)).toString()).toContain(body2);

      // REMOVE by the owner → gone from storage
      await x.kyb.removeDocument(sellerId, storeId, String(d2._id));
      expect(await exists(d2)).toBe(false);

      // PURGE by the retention job → gone from storage
      const body3 = `kyb real storage ${Date.now()} three`;
      await x.kyb.uploadDocument(sellerId, storeId, 'bank_proof', pdf('bank.pdf', body3));
      const raw3: any = await x.kybModel.findOne({ storeId }).lean();
      const d3 = raw3.documents[0]; created.push({ publicId: d3.publicId, resourceType: d3.resourceType });
      await x.maintenance.updateSettings('adm', { afterClosureDays: 30, purgeEnabled: true });
      await x.h.repos.storeModel.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(storeId) }, { $set: { isDelete: true, updatedAt: new Date(Date.now() - 100 * 86400_000) } });
      expect(await x.maintenance.runRetention({ dryRun: false })).toMatchObject({ purged: 1, failed: 0 });
      expect(await exists(d3)).toBe(false);

      // nothing in any log channel contains a link, a signature, or a storage id
      const all = logged.join('\n');
      for (const needle of [view.url, 'api.cloudinary.com', 'signature=', 'expires_at=', d1.publicId, d2.publicId, d3.publicId, 'private_download']) expect(all).not.toContain(needle);
    } finally {
      sinks.forEach((s) => s.mockRestore());
      for (const c of created) await upload.deletePrivateFile(c.publicId, c.resourceType).catch(() => undefined); // belt and braces: leave nothing behind
      await x.stop(); setKybKeys({ v1: false, current: null });
    }
  });
});
