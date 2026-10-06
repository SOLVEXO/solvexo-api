/* eslint-disable prettier/prettier */
import { NotFoundException } from '@nestjs/common';
import { MetaobjectsService } from './metaobjects.service';
import { DatabaseService } from '../database/databaseservice';

describe('MetaobjectsService public reads — Storefronts access', () => {
  const defs: any[] = [
    { _id: 'a', storeId: 's', type: 'team', name: 'Team', storefrontAccess: true },
    { _id: 'b', storeId: 's', type: 'internal', name: 'Internal', storefrontAccess: false },
    { _id: 'c', storeId: 's', type: 'legacy', name: 'Legacy' },
  ];
  const entries: any[] = [
    { _id: 'e1', storeId: 's', definitionId: 'a', type: 'team', displayName: 'Jane', fields: [], createdAt: 1 },
    { _id: 'e2', storeId: 's', definitionId: 'b', type: 'internal', displayName: 'Hidden', fields: [] },
  ];
  // Minimal matcher for { storefrontAccess: { $ne: false } }
  const matches = (d: any, f: any) =>
    Object.entries(f).every(([k, v]: [string, any]) =>
      v && typeof v === 'object' && '$ne' in v ? d[k] !== v.$ne : d[k] === v);
  const chain = (rows: any[]) => { const c: any = { select: () => c, sort: () => c, lean: () => Promise.resolve(rows) }; return c; };
  let service: MetaobjectsService;

  beforeEach(() => {
    const definitionModel = {
      find: (f: any) => chain(defs.filter(d => matches(d, f))),
      findOne: (f: any) => chain(defs.find(d => matches(d, f)) ?? null),
    };
    const entryModel = {
      find: (f: any) => chain(entries.filter(e => matches(e, f))),
      findOne: (f: any) => chain(entries.find(e => matches(e, f)) ?? null),
    };
    service = new MetaobjectsService({ repositories: { metaobjectDefinitionModel: definitionModel, metaobjectEntryModel: entryModel, storeModel: {} } } as unknown as DatabaseService);
  });

  it('definitions list hides storefrontAccess=false, keeps true and legacy (default on)', async () => {
    const res = await service.getPublicDefinitions('s');
    expect(res.data.map((d: any) => d.type)).toEqual(['team', 'legacy']);
  });

  it('entries by type: empty for a private type, populated for an accessible one', async () => {
    expect((await service.getPublicEntriesByType('s', 'internal')).data).toEqual([]);
    expect((await service.getPublicEntriesByType('s', 'team')).data).toHaveLength(1);
  });

  it('single entry of a private type is a 404; accessible entry omits definitionId', async () => {
    await expect(service.getPublicEntry('s', 'e2')).rejects.toBeInstanceOf(NotFoundException);
    const ok = await service.getPublicEntry('s', 'e1');
    expect((ok.data as any).displayName).toBe('Jane');
    expect((ok.data as any).definitionId).toBeUndefined();
  });
});
