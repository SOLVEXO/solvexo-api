/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { CollectionTemplateService } from './collection-template.service';
import { DatabaseService } from '../database/databaseservice';
import { ContentVersioningService } from '../common/content-versioning/content-versioning.service';
import { PRODUCT_MAIN_BLOCK_TYPES } from './core-sections.util';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';

describe('CollectionTemplateService — core sections (Phase 4)', () => {
  let service: CollectionTemplateService;
  let collectionTemplateModel: any;
  let storeModel: any;
  let db: DatabaseService;

  beforeEach(() => {
    storeModel = {
      findById: jest.fn().mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false }),
    };
    db = { repositories: { collectionTemplateModel: undefined as any, storeModel } } as unknown as DatabaseService;
    service = new CollectionTemplateService(db, new ContentVersioningService());
  });

  /** A faithful-enough fake of Mongo's real `findOneAndUpdate` for exactly
   *  the shape `backfillCoreSections` issues: a filter that (optionally)
   *  requires `sections`/`draft.sections` to NOT already contain a given
   *  type (`$ne`), and a `$push` with `$each`/`$position`. Returns `null`
   *  when the filter's `$ne` condition no longer holds — the real Mongo
   *  behavior this method's race-safety depends on. Shared by both tests
   *  below so the race test can reuse the exact same semantics. */
  function fakeFindOneAndUpdate(doc: any) {
    return jest.fn().mockImplementation((filter: any, update: any) => {
      if (update.$push) {
        const [field, spec] = Object.entries(update.$push)[0] as [string, any];
        const arr = field === 'draft.sections' ? doc.draft.sections : doc.sections;
        const neType = field === 'draft.sections' ? filter['draft.sections.type']?.$ne : filter['sections.type']?.$ne;
        if (neType && arr.some((s: any) => s.type === neType)) return Promise.resolve(null); // filter no longer matches — real Mongo returns no doc
        arr.unshift(...spec.$each);
        return Promise.resolve(doc);
      }
      return Promise.resolve(doc);
    });
  }

  it('backfills the missing core section (with its blocks) onto a pre-existing, never-seeded product template — once, not again on a repeat call', async () => {
    // Simulates a real product template row created before this feature
    // existed: `sections`/`draft.sections` are both still `[]`.
    const doc: any = { _id: 'tpl-1', storeId: STORE_ID, resourceType: 'product', templateKey: 'default', sections: [] as any[], draft: { sections: [] as any[] } };
    collectionTemplateModel = { findOneAndUpdate: fakeFindOneAndUpdate(doc) };
    (db.repositories as any).collectionTemplateModel = collectionTemplateModel;

    const first = await service.ensureTemplate(STORE_ID, 'product', 'default');
    expect(first.sections[0].type).toBe('product_main');
    expect(first.sections[0].blocks.map((b: any) => b.type)).toEqual([...PRODUCT_MAIN_BLOCK_TYPES]);
    expect(doc.sections.filter((s: any) => s.type === 'product_main')).toHaveLength(1);
    expect(doc.draft.sections.filter((s: any) => s.type === 'product_main')).toHaveLength(1);

    // Second call against the now-backfilled doc must be a genuine no-op —
    // no duplicate product_main entry in either sections array.
    await service.ensureTemplate(STORE_ID, 'product', 'default');
    expect(doc.sections.filter((s: any) => s.type === 'product_main')).toHaveLength(1);
    expect(doc.draft.sections.filter((s: any) => s.type === 'product_main')).toHaveLength(1);
  });

  it('never double-inserts under a real race — two concurrent ensureTemplate calls against the same never-yet-backfilled template', async () => {
    // Reproduces the exact bug found via live browser testing: two
    // near-simultaneous callers (e.g. the same merchant with this template
    // open in two tabs) both reading "not present yet" before either had
    // written. The atomic, filter-checked-at-write-time `$ne` is what
    // prevents both from winning.
    const doc: any = { _id: 'tpl-1', storeId: STORE_ID, resourceType: 'cart', templateKey: 'cart', sections: [] as any[], draft: { sections: [] as any[] } };
    collectionTemplateModel = { findOneAndUpdate: fakeFindOneAndUpdate(doc) };
    (db.repositories as any).collectionTemplateModel = collectionTemplateModel;

    await Promise.all([
      service.ensureTemplate(STORE_ID, 'page', 'cart'),
      service.ensureTemplate(STORE_ID, 'page', 'cart'),
    ]);

    expect(doc.sections.filter((s: any) => s.type === 'cart_items')).toHaveLength(1);
    expect(doc.sections.filter((s: any) => s.type === 'cart_summary')).toHaveLength(1);
    expect(doc.draft.sections.filter((s: any) => s.type === 'cart_items')).toHaveLength(1);
    expect(doc.draft.sections.filter((s: any) => s.type === 'cart_summary')).toHaveLength(1);
  });

  it('rejects saving a product template whose draft removes the required product_main section entirely', async () => {
    const doc = {
      _id: 'tpl-1', storeId: STORE_ID, resourceType: 'product', templateKey: 'default',
      sections: [{ type: 'product_main', blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t })) }],
      draft: { sections: [{ type: 'product_main', blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t })) }] },
    };
    collectionTemplateModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(doc),
      findOne: jest.fn().mockResolvedValue(doc),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    (db.repositories as any).collectionTemplateModel = collectionTemplateModel;

    await expect(
      service.updateSections(STORE_ID, SELLER_ID, { sections: [] } as any, 'product', 'default'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects saving a product_main section that is missing one of its 7 required blocks', async () => {
    const doc = {
      _id: 'tpl-1', storeId: STORE_ID, resourceType: 'product', templateKey: 'default',
      sections: [{ type: 'product_main', blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t })) }],
      draft: { sections: [{ type: 'product_main', blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t })) }] },
    };
    collectionTemplateModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(doc),
      findOne: jest.fn().mockResolvedValue(doc),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    (db.repositories as any).collectionTemplateModel = collectionTemplateModel;

    const incomplete = { type: 'product_main', settings: {}, blocks: [{ type: 'product_title', settings: {} }] };
    await expect(
      service.updateSections(STORE_ID, SELLER_ID, { sections: [incomplete] } as any, 'product', 'default'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows saving a product template that keeps product_main intact and adds a surrounding section', async () => {
    const doc = {
      _id: 'tpl-1', storeId: STORE_ID, resourceType: 'product', templateKey: 'default',
      sections: [{ type: 'product_main', blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t })) }],
      draft: { sections: [{ type: 'product_main', blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t })) }] },
    };
    collectionTemplateModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(doc),
      findOne: jest.fn().mockResolvedValue(doc),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    (db.repositories as any).collectionTemplateModel = collectionTemplateModel;

    const productMain = { type: 'product_main', settings: {}, blocks: PRODUCT_MAIN_BLOCK_TYPES.map(t => ({ type: t, settings: {} })) };
    const richText = { type: 'rich_text', settings: { alignment: 'left' }, blocks: [] };
    const result = await service.updateSections(STORE_ID, SELLER_ID, { sections: [productMain, richText] } as any, 'product', 'default');
    expect(result.success).toBe(true);
  });
});
