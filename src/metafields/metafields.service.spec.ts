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
