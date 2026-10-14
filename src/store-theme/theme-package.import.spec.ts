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
  const repositories: any = {
    storeModel: { findById: async () => ({ isDelete: false, sellerId: 'seller1' }) },
    storeThemeModel: { findOne: () => query({ _id: 'theme1' }) },
    themeImportJobModel: {
      create: async (doc: any) => { const row = { _id: String(jobs.length + 1).padStart(24, 'a'), updatedAt: new Date(), ...doc }; jobs.push(row); return row; },
      findOne: (filter: any) => query(jobs.find((j) => (filter._id ? j._id === filter._id : j.status === filter.status)) ?? null),
      updateOne: async (filter: any, update: any) => { Object.assign(jobs.find((j) => j._id === filter._id) ?? {}, update.$set, { updatedAt: new Date() }); },
    },
    themePackageModel: {
      findOne: () => query(packages.length ? { version: packages[packages.length - 1].version } : null),
      create: async (doc: any) => { packages.push(doc); return doc; },
      updateOne: async (filter: any, update: any) => { Object.assign(packages.find((p) => p.version === filter.version) ?? {}, update.$set); },
      deleteMany: async () => ({}),
      distinct: async () => [],
    },
    themePackageAssetModel: { bulkWrite: async (ops: any[]) => { assets.push(...ops); }, deleteMany: async () => ({}) },
  };
  repositories.storeThemeModel.findOne = () => query({ _id: 'theme1', sourcePackageVersion: null });
  return { service: new ThemePackageService({ repositories } as any), jobs, packages, assets };
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
