/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { MetafieldsService } from './metafields.service';
import { DatabaseService } from '../database/databaseservice';

const STORE_A = 'store-a';
const STORE_B = 'store-b';

describe('MetafieldsService.assertDynamicSourceBindingsValid (Phase 9)', () => {
  let service: MetafieldsService;
  let definitionModel: any;
  let db: DatabaseService;

  const seed = (rows: { storeId: string; ownerResource: string; namespace: string; key: string; name: string; type: string }[]) => {
    definitionModel.rows = rows;
  };

  beforeEach(() => {
    definitionModel = {
      rows: [] as any[],
      find: jest.fn().mockImplementation((filter: any) => ({
        lean: () => Promise.resolve(definitionModel.rows.filter((r: any) => r.storeId === filter.storeId && r.ownerResource === filter.ownerResource)),
      })),
    };
    db = { repositories: { metafieldDefinitionModel: definitionModel, metafieldValueModel: {}, storeModel: {} } } as unknown as DatabaseService;
    service = new MetafieldsService(db);
  });

  const sectionsWithParagraphBinding = (namespace = 'custom', key = 'fabric') => [
    { type: 'rich_text', settings: {}, blocks: [{ type: 'paragraph', settings: { dynamicSourceNamespace: namespace, dynamicSourceKey: key } }] },
  ];

  it('passes through untouched when no section/block carries a dynamic source', async () => {
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'product', [{ type: 'hero', settings: {}, blocks: [] }])).resolves.toBeUndefined();
  });

  it('rejects any binding when ownerResource is null (e.g. the Home page — no single real resource to bind to)', async () => {
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, null, sectionsWithParagraphBinding())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a key that has no matching definition for this store (typo/deleted — closes the old silent no-op)', async () => {
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'product', sectionsWithParagraphBinding())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a key that only exists for a DIFFERENT store (tenant isolation)', async () => {
    seed([{ storeId: STORE_B, ownerResource: 'product', namespace: 'custom', key: 'fabric', name: 'Fabric', type: 'single_line_text_field' }]);
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'product', sectionsWithParagraphBinding())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a key that exists for this store but under a DIFFERENT ownerResource', async () => {
    seed([{ storeId: STORE_A, ownerResource: 'collection', namespace: 'custom', key: 'fabric', name: 'Fabric', type: 'single_line_text_field' }]);
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'product', sectionsWithParagraphBinding())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a source-type-incompatible metafield (json) bound to a text-rendering field', async () => {
    seed([{ storeId: STORE_A, ownerResource: 'product', namespace: 'custom', key: 'spec', name: 'Spec Sheet', type: 'json' }]);
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'product', sectionsWithParagraphBinding('custom', 'spec'))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a real, correctly-scoped, type-compatible binding', async () => {
    seed([{ storeId: STORE_A, ownerResource: 'product', namespace: 'custom', key: 'fabric', name: 'Fabric', type: 'single_line_text_field' }]);
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'product', sectionsWithParagraphBinding())).resolves.toBeUndefined();
  });

  it('accepts a non-json, non-text type too (e.g. a number) — only json is excluded', async () => {
    seed([{ storeId: STORE_A, ownerResource: 'article', namespace: 'custom', key: 'readTime', name: 'Read Time', type: 'number_integer' }]);
    const sections = [{ type: 'rich_text', settings: {}, blocks: [{ type: 'heading', settings: { dynamicSourceNamespace: 'custom', dynamicSourceKey: 'readTime' } }] }];
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'article', sections)).resolves.toBeUndefined();
  });

  it('validates a SECTION-level binding (rich_text\'s own heading), not just block-level', async () => {
    seed([{ storeId: STORE_A, ownerResource: 'collection', namespace: 'custom', key: 'tagline', name: 'Tagline', type: 'single_line_text_field' }]);
    const sections = [{ type: 'rich_text', settings: { dynamicSourceNamespace: 'custom', dynamicSourceKey: 'tagline' }, blocks: [] }];
    await expect(service.assertDynamicSourceBindingsValid(STORE_A, 'collection', sections)).resolves.toBeUndefined();
  });
});

describe('MetafieldsService: deleting a spec and counting where it is used', () => {
  const def = { _id: 'd1', storeId: STORE_A, ownerResource: 'product', namespace: 'custom', key: 'fabric', name: 'Fabric', type: 'single_line_text_field', deleteOne: jest.fn() };
  let values: any[];
  let service: MetafieldsService;
  const build = (definition: any = def) => {
    values = [
      { storeId: STORE_A, ownerResource: 'product', ownerId: 'p1', namespace: 'custom', key: 'fabric', value: 'Cotton' },
      { storeId: STORE_A, ownerResource: 'product', ownerId: 'p2', namespace: 'custom', key: 'fabric', value: 'Silk' },
      { storeId: STORE_A, ownerResource: 'product', ownerId: 'p3', namespace: 'custom', key: 'fabric', value: '' }, // blank: not "used"
      { storeId: STORE_A, ownerResource: 'product', ownerId: 'p1', namespace: 'custom', key: 'season', value: 'Winter' }, // another spec
      { storeId: STORE_B, ownerResource: 'product', ownerId: 'x1', namespace: 'custom', key: 'fabric', value: 'Wool' }, // another store
    ];
    const match = (f: any) => (r: any) => r.storeId === f.storeId && r.ownerResource === f.ownerResource && r.namespace === f.namespace && r.key === f.key;
    const db = {
      repositories: {
        storeModel: { findById: async () => ({ sellerId: 'sel1', isDelete: false }) },
        metafieldDefinitionModel: { findOne: async (f: any) => (definition && f._id === definition._id && f.storeId === definition.storeId ? definition : null) },
        metafieldValueModel: {
          distinct: async (field: string, f: any) => [...new Set(values.filter(match(f)).filter(r => !(f.value?.$nin ?? []).includes(r.value)).map((r: any) => r[field]))],
          deleteMany: jest.fn(async (f: any) => { const before = values.length; values = values.filter(r => !match(f)(r)); return { deletedCount: before - values.length }; }),
        },
      },
    } as unknown as DatabaseService;
    service = new MetafieldsService(db);
    return db;
  };

  it('counts the products that have a real value, ignoring blanks, other specs and other stores', async () => {
    build();
    const res: any = await service.getDefinitionUsage(STORE_A, 'sel1', 'd1');
    expect(res.data.used).toBe(2);
  });

  it('says 0 when no product has a value, and 404s for a spec of another store', async () => {
    build();
    values = [];
    expect(((await service.getDefinitionUsage(STORE_A, 'sel1', 'd1')) as any).data.used).toBe(0);
    await expect(service.getDefinitionUsage(STORE_B, 'sel1', 'd1')).rejects.toThrow('not found');
  });

  it('deleting the spec removes its values everywhere in this store and nothing else', async () => {
    const db: any = build();
    await service.deleteDefinition(STORE_A, 'sel1', 'd1');
    expect((def.deleteOne as any).mock.calls.length).toBe(1);
    expect(db.repositories.metafieldValueModel.deleteMany.mock.calls.length).toBe(1);
    expect(values.some(r => r.storeId === STORE_A && r.key === 'fabric')).toBe(false);
    expect(values.some(r => r.storeId === STORE_A && r.key === 'season')).toBe(true);
    expect(values.some(r => r.storeId === STORE_B && r.key === 'fabric')).toBe(true);
  });

  it('refuses another seller', async () => {
    const db: any = build();
    db.repositories.storeModel.findById = async () => ({ sellerId: 'someone-else', isDelete: false });
    await expect(service.getDefinitionUsage(STORE_A, 'sel1', 'd1')).rejects.toThrow('Access denied');
  });
});
