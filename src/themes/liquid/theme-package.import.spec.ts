import { BadRequestException } from '@nestjs/common';
import { ThemePackageService, buildStoredZip } from './theme-package.service';

// In-memory stand-ins for the Mongoose models used by the background import.
const query = (value: any) => {
  const q: any = { select: () => q, sort: () => q, lean: () => Promise.resolve(value), then: (a: any, b: any) => Promise.resolve(value).then(a, b) };
  return q;
};

function makeService() {
  const jobs: any[] = [];
  const packages: any[] = [];
  const assets: any[] = [];
  const uploadChunks: any[] = [];
  const repositories: any = {
    storeModel: { findById: async () => ({ isDelete: false, sellerId: 'seller1' }) },
    storeThemeModel: { findOne: () => query({ _id: 'theme1' }) },
    themeImportJobModel: {
      create: async (doc: any) => { const row = { _id: String(jobs.length + 1).padStart(24, 'a'), updatedAt: new Date(), ...doc }; jobs.push(row); return row; },
      findOne: (filter: any) => query(jobs.find((j) => (filter._id ? j._id === filter._id : j.status === filter.status)) ?? null),
      findById: (id: string) => query(jobs.find((j) => j._id === id) ?? null),
      updateOne: async (filter: any, update: any) => {
        const row = jobs.find((j) => j._id === filter._id);
        if (!row) return;
        if (update.$set) Object.assign(row, update.$set, { updatedAt: new Date() });
        if (update.$unset) for (const key of Object.keys(update.$unset)) delete row[key];
      },
    },
    themePackageModel: {
      findOne: () => query(packages.length ? { version: packages[packages.length - 1].version } : null),
      create: async (doc: any) => { packages.push(doc); return doc; },
      updateOne: async (filter: any, update: any) => { Object.assign(packages.find((p) => p.version === filter.version) ?? {}, update.$set); },
      deleteMany: async () => ({}),
      distinct: async () => [],
    },
    themeUploadChunkModel: {
      updateOne: async (filter: any, update: any) => { const row = uploadChunks.find((c) => c.uploadId === filter.uploadId && c.index === filter.index); if (row) Object.assign(row, update.$set); else uploadChunks.push({ ...update.$set }); },
      find: (filter: any) => query(uploadChunks.filter((c) => c.uploadId === filter.uploadId).sort((a, b) => a.index - b.index)),
      deleteMany: async (filter: any) => { for (let i = uploadChunks.length - 1; i >= 0; i--) if (uploadChunks[i].uploadId === filter.uploadId) uploadChunks.splice(i, 1); },
    },
    themePackageAssetModel: { bulkWrite: async (ops: any[]) => { assets.push(...ops); }, deleteMany: async () => ({}) },
  };
  repositories.storeThemeModel.findOne = () => query({ _id: 'theme1', sourcePackageVersion: null });
  // Stands in for BullMQ: in production a separate worker process picks this job up (see ThemeImportProcessor);
  // here it just runs the same method straight away, keeping these tests fast and Redis-free.
  const fakeQueue: any = { add: async (_name: string, data: { jobId: string }) => { void service.processImportJob(data.jobId); } };
  const service = new ThemePackageService({ repositories } as any, fakeQueue);
  return { service, jobs, packages, assets, uploadChunks };
}

const zipOf = (entries: Record<string, string>) => buildStoredZip(Object.entries(entries).map(([path, text]) => ({ path, data: Buffer.from(text) })));
const waitForJob = async (service: ThemePackageService, jobId: string) => {
  for (let i = 0; i < 100; i++) {
    const job = (await service.getImportJob('store1', 'seller1', 'theme1', jobId)).data;
    if (job.status !== 'processing') return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('import never finished');
};

describe('background theme import', () => {
  it('answers at once, then saves the revision, stores binary assets separately and records a compatibility report', async () => {
    const { service, packages, assets } = makeService();
    const zip = zipOf({
      'layout/theme.liquid': '<html><body>{{ content_for_layout }}</body></html>',
      'templates/index.json': JSON.stringify({ sections: { m: { type: 'main' } }, order: ['m'] }),
      'sections/main.liquid': '<h1>Hello</h1>',
      'assets/logo.png': 'PNGDATA',
    });
    const started = await service.startImport('store1', 'seller1', 'theme1', zip, 'theme.zip');
    expect(started.data.status).toBe('processing');
    const job = await waitForJob(service, started.data.jobId);
    expect(job.status).toBe('ready');
    expect(job.version).toBe(1);
    expect(assets).toHaveLength(1); // the png is stored once in the asset collection
    expect(packages[0].files.find((f: any) => f.path === 'assets/logo.png')).toMatchObject({ external: true, content: '' });
    expect(packages[0].compatibility.pages.find((p: any) => p.label === 'Home page').ok).toBe(true);
  });

  it('reports a clear reason when the ZIP is not a theme', async () => {
    const { service } = makeService();
    const started = await service.startImport('store1', 'seller1', 'theme1', zipOf({ 'README.md': 'x', 'sections/a.liquid': '<p/>' }), 'x.zip');
    const job = await waitForJob(service, started.data.jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/layout\/theme\.liquid/);
  });

  it('rejects a non-ZIP upload before starting a job', async () => {
    const { service, jobs } = makeService();
    await expect(service.startImport('store1', 'seller1', 'theme1', Buffer.from('not a zip'))).rejects.toBeInstanceOf(BadRequestException);
    expect(jobs).toHaveLength(0);
  });
});

describe('resumable chunked upload', () => {
  const themeZip = () => zipOf({
    'layout/theme.liquid': '<html><body>{{ content_for_layout }}</body></html>',
    'templates/index.liquid': '<h1>Chunked</h1>',
  });
  const UPLOAD_ID = '11111111-2222-3333-4444-555555555555';

  it('assembles pieces that arrive out of order (and retried) into one theme and imports it', async () => {
    const { service, uploadChunks } = makeService();
    const zip = themeZip();
    const size = Math.ceil(zip.length / 3);
    const pieces = [0, 1, 2].map((i) => zip.subarray(i * size, (i + 1) * size));
    await service.saveUploadChunk('store1', 'seller1', 'theme1', UPLOAD_ID, 2, 3, pieces[2]);
    await service.saveUploadChunk('store1', 'seller1', 'theme1', UPLOAD_ID, 0, 3, pieces[0]);
    await service.saveUploadChunk('store1', 'seller1', 'theme1', UPLOAD_ID, 0, 3, pieces[0]); // a retry replaces, never duplicates
    await service.saveUploadChunk('store1', 'seller1', 'theme1', UPLOAD_ID, 1, 3, pieces[1]);
    expect(uploadChunks).toHaveLength(3);
    const started = await service.completeUpload('store1', 'seller1', 'theme1', UPLOAD_ID, 3, 'theme.zip');
    const job = await waitForJob(service, started.data.jobId);
    expect(job.status).toBe('ready');
    expect(uploadChunks).toHaveLength(0); // temporary pieces are removed
  });

  it('refuses to assemble when a piece is missing, and rejects a bad upload id', async () => {
    const { service } = makeService();
    const zip = themeZip();
    await service.saveUploadChunk('store1', 'seller1', 'theme1', UPLOAD_ID, 0, 2, zip.subarray(0, 10));
    await expect(service.completeUpload('store1', 'seller1', 'theme1', UPLOAD_ID, 2)).rejects.toThrow(/incomplete/i);
    await expect(service.saveUploadChunk('store1', 'seller1', 'theme1', '../../x', 0, 1, zip)).rejects.toBeInstanceOf(BadRequestException);
  });
});
