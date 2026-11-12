import { removeAiStudioData, type CleanupDb } from './remove-ai-studio-data';

/** A tiny in-memory database: collections of plain documents. */
function fakeDb(data: Record<string, any[]>) {
  const calls: string[] = [];
  const has = (doc: any, filter: any): boolean => Object.entries(filter).every(([k, cond]: [string, any]) => {
    const v = doc[k];
    if (cond && typeof cond === 'object' && '$in' in cond) return Array.isArray(v) ? v.some((x) => cond.$in.includes(x)) : cond.$in.includes(v);
    return v === cond;
  });
  const db: CleanupDb = {
    listCollections: () => ({ toArray: async () => Object.keys(data).map((name) => ({ name })) }),
    collection: (name: string) => ({
      countDocuments: async (f) => (data[name] ?? []).filter((d) => has(d, f)).length,
      drop: async () => { calls.push(`drop ${name}`); delete data[name]; },
      updateMany: async (f, u: any) => {
        calls.push(`update ${name}`);
        for (const d of data[name].filter((x) => has(x, f))) d.enabledTools = d.enabledTools.filter((t: string) => !u.$pull.enabledTools.$in.includes(t));
      },
      deleteMany: async (f) => { calls.push(`delete ${name}`); data[name] = data[name].filter((d) => !has(d, f)); },
    }),
  };
  return { db, data, calls };
}

const seed = () => ({
  aigenerations: [{ _id: 1 }, { _id: 2 }],
  aicredittransactions: [{ _id: 1 }],
  aicreditswallets: [{ storeId: 's1', balance: 90 }],
  stores: [{ _id: 's1', enabledTools: ['ai_studio', 'inventory_manager'] }, { _id: 's2', enabledTools: ['ai_worksheet_builder', 'ai_studio'] }, { _id: 's3', enabledTools: ['marketplace_listing'] }],
  activitylogs: [{ category: 'ai_studio' }, { category: 'ai_studio' }, { category: 'seo' }],
});

describe('remove-ai-studio-data', () => {
  it('a dry run reports everything and changes nothing', async () => {
    const k = fakeDb(seed());
    const lines: string[] = [];
    const r = await removeAiStudioData(k.db, false, (l) => lines.push(l));
    expect(r.collections).toEqual({ aigenerations: 2, aicredittransactions: 1 });
    expect(r.storesCleaned).toBe(2);
    expect(r.logRows).toBe(2);
    expect(k.calls).toEqual([]);
    expect(k.data.aigenerations.length).toBe(2);
    expect(lines.some((l) => l.includes('Dry run only'))).toBe(true);
  });

  it('apply drops the two collections, cleans the store tools and deletes only the AI Studio log rows', async () => {
    const k = fakeDb(seed());
    await removeAiStudioData(k.db, true);
    expect(k.data.aigenerations === undefined).toBe(true);
    expect(k.data.aicredittransactions === undefined).toBe(true);
    expect(k.data.stores.map((s: any) => s.enabledTools)).toEqual([['inventory_manager'], [], ['marketplace_listing']]);
    expect(k.data.activitylogs).toEqual([{ category: 'seo' }]);
  });

  it('never touches the AI credits wallets (AI SEO still spends them)', async () => {
    const k = fakeDb(seed());
    await removeAiStudioData(k.db, true);
    expect(k.data.aicreditswallets).toEqual([{ storeId: 's1', balance: 90 }]);
    expect(k.calls.some((c) => c.includes('aicreditswallets'))).toBe(false);
  });

  it('running it again changes nothing and does not fail', async () => {
    const k = fakeDb(seed());
    await removeAiStudioData(k.db, true);
    const again = await removeAiStudioData(k.db, true);
    expect(again.collections).toEqual({ aigenerations: null, aicredittransactions: null });
    expect(again.storesCleaned).toBe(0);
    expect(again.logRows).toBe(0);
  });

  it('a database that never had any of it is fine', async () => {
    const k = fakeDb({ products: [{ _id: 1 }] });
    const r = await removeAiStudioData(k.db, true);
    expect(r.collections).toEqual({ aigenerations: null, aicredittransactions: null });
    expect(k.calls).toEqual([]);
  });
});
