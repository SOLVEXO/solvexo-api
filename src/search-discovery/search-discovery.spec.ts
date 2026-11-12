/* eslint-disable prettier/prettier */
import mongoose, { Connection, Types } from 'mongoose';
import { cleanFilters, cleanPinned, cleanSynonymGroups, expandQuery, pinnedFor, reportableQuery, termsRegexSource } from './search-discovery.util';
import { SearchConfigSchema, SearchMissSchema } from './search-discovery.schema';
import { SearchDiscoveryService } from './search-discovery.service';

const G = [{ terms: ['sofa', 'couch', 'settee'] }, { terms: ['tee', 't-shirt'] }];

describe('synonyms', () => {
  it('a typed word brings its group; the typed query stays first; unrelated words add nothing', () => {
    expect(expandQuery(G, 'Couch')).toEqual(['couch', 'sofa', 'settee']);
    expect(expandQuery(G, 'blue sofa')).toEqual(['blue sofa', 'sofa', 'couch', 'settee']);
    expect(expandQuery(G, 'lamp')).toEqual(['lamp']);
    expect(expandQuery(G, '  ')).toEqual([]);
  });
  it('regex source escapes every term', () => { expect(termsRegexSource(['t-shirt', 'a.b', 'c+d'])).toBe('t-shirt|a\\.b|c\\+d'); });
  it('cleaning: lowercased, deduped, a group needs two distinct terms', () => {
    expect(cleanSynonymGroups([{ terms: ['Sofa', 'sofa', ' COUCH '] }, { terms: ['alone'] }, { terms: [] }])).toEqual([{ terms: ['sofa', 'couch'] }]);
    expect(() => cleanSynonymGroups('x' as any)).toThrow();
  });
});

describe('pinned products', () => {
  const id = (n: number) => n.toString(16).padStart(24, '0');
  it('cleaning drops bad ids, empty and duplicate queries', () => {
    expect(cleanPinned([{ query: 'Sofa', productIds: [id(1), 'nope', id(1)] }, { query: 'sofa', productIds: [id(2)] }, { query: '', productIds: [id(3)] }, { query: 'x', productIds: [] }])).toEqual([{ query: 'sofa', productIds: [id(1)] }]);
  });
  it('a pin applies when the query (or one of its synonyms) matches exactly', () => {
    const pins = [{ query: 'sofa', productIds: ['a', 'b'] }];
    expect(pinnedFor(pins, expandQuery(G, 'couch'))).toEqual(['a', 'b']);
    expect(pinnedFor(pins, expandQuery(G, 'sofa bed'))).toEqual(['a', 'b']);
    expect(pinnedFor(pins, expandQuery(G, 'lamp'))).toEqual([]);
  });
});

describe('filters and report', () => {
  it('unknown filter keys are dropped and missing ones come back enabled', () => {
    const f = cleanFilters([{ key: 'price', enabled: false }, { key: 'bogus' }, { key: 'vendor' }]);
    expect(f.map((x) => x.key)).toEqual(['price', 'vendor', 'availability', 'tags', 'options']);
    expect(f.find((x) => x.key === 'price')!.enabled).toBe(false); expect(f.find((x) => x.key === 'tags')!.enabled).toBe(true);
  });
  it('only meaningful queries are reported', () => { expect(reportableQuery(' Red  Shoes ')).toBe('red shoes'); expect(reportableQuery('a')).toBeNull(); expect(reportableQuery('!!')).toBeNull(); });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('SearchDiscoveryService on a real MongoDB', () => {
  jest.setTimeout(60000);
  let conn: Connection; let svc: SearchDiscoveryService; const S1 = new Types.ObjectId().toHexString(); const S2 = new Types.ObjectId().toHexString(); let own: string; let foreign: string;
  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `search_it_${Date.now()}` }).asPromise();
    const cfg = conn.model('SearchConfig', SearchConfigSchema); const miss = conn.model('SearchMiss', SearchMissSchema); await miss.init();
    const productModel = conn.model('Product', new mongoose.Schema({}, { strict: false }));
    own = String(((await productModel.create({ storeId: S1, isDelete: false })) as any)._id); foreign = String(((await productModel.create({ storeId: S2, isDelete: false })) as any)._id);
    svc = new SearchDiscoveryService(cfg as any, miss as any, { repositories: { productModel } } as any);
  });
  afterAll(async () => { await conn?.dropDatabase(); await conn?.close(); });

  it('saves synonyms and expands them for that store only', async () => {
    await svc.save(S1, { synonyms: [{ terms: ['sofa', 'couch'] }] });
    expect(await svc.terms(S1, 'couch')).toEqual(['couch', 'sofa']);
    expect(await svc.terms(S2, 'couch')).toEqual(['couch']);
    expect(await svc.regexSource(S1, 'couch')).toBe('couch|sofa'); expect(await svc.regexSource(S2, 'couch')).toBeNull();
  });
  it('a pin can only point at this store\'s own products', async () => {
    const r = await svc.save(S1, { pinned: [{ query: 'sofa', productIds: [own, foreign] }] });
    expect(r.pinned).toEqual([{ query: 'sofa', productIds: [own] }]);
    expect(await svc.pinned(S1, 'couch')).toEqual([own]); expect(await svc.pinned(S2, 'sofa')).toEqual([]);
  });
  it('bad input is rejected with a clear error, and nothing is half-saved', async () => {
    await expect(svc.save(S1, { synonyms: 'x' })).rejects.toThrow(/list/);
  });
  it('searches with no result are counted per store and can be cleared', async () => {
    await svc.recordMiss(S1, 'Red Shoes'); await svc.recordMiss(S1, 'red shoes'); await svc.recordMiss(S1, 'x'); await svc.recordMiss(S2, 'red shoes');
    const r = await svc.noResults(S1, {});
    expect(r.items).toHaveLength(1); expect(r.items[0]).toMatchObject({ query: 'red shoes', count: 2 });
    await svc.clearMiss(S1, 'RED SHOES');
    expect((await svc.noResults(S1, {})).total).toBe(0); expect((await svc.noResults(S2, {})).total).toBe(1);
  });
  it('filters default to all on and keep the seller order', async () => {
    expect((await svc.publicFilters(S2)).filters.every((f: any) => f.enabled)).toBe(true);
    await svc.save(S1, { filters: [{ key: 'vendor', enabled: false }] });
    const f = (await svc.getConfig(S1)).filters; expect(f[0]).toEqual({ key: 'vendor', enabled: false });
  });
});
