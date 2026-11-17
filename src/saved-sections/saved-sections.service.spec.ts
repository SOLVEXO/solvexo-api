import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SavedSectionsService, assertSavedSectionContent, MAX_SAVED_SECTIONS } from './saved-sections.service';

/** Tiny in-memory stand-ins for the Mongoose models the service touches. */
function makeService(opts: { pages?: any[]; templates?: any[] } = {}) {
  const rows: any[] = [];
  let seq = 0;
  const lean = <T,>(v: T) => ({ lean: async () => v, sort: () => ({ lean: async () => v }), select: () => ({ lean: async () => v }) });
  const model: any = {
    rows,
    find: (f: any) => lean(rows.filter(r => r.storeId === f.storeId)),
    countDocuments: async (f: any) => rows.filter(r => r.storeId === f.storeId).length,
    create: async (d: any) => {
      if (rows.some(r => r.storeId === d.storeId && r.nameKey === d.nameKey)) throw Object.assign(new Error('dup'), { code: 11000 });
      const row = { _id: 'a'.repeat(23) + String(++seq), ...d };
      rows.push(row);
      return { toObject: () => row };
    },
    findOne: async (f: any) => rows.find(r => String(r._id) === String(f._id) && r.storeId === f.storeId) ?? null,
    findOneAndUpdate: (f: any, u: any) => ({
      lean: async () => {
        const row = rows.find(r => String(r._id) === String(f._id) && r.storeId === f.storeId);
        if (row && u.$set?.nameKey && rows.some(r => r !== row && r.storeId === f.storeId && r.nameKey === u.$set.nameKey)) throw Object.assign(new Error('dup'), { code: 11000 });
        if (row) Object.assign(row, u.$set);
        return row;
      },
    }),
    deleteOne: async (f: any) => { const i = rows.findIndex(r => String(r._id) === String(f._id)); if (i >= 0) rows.splice(i, 1); },
  };
  const db: any = {
    repositories: {
      storeModel: { findOne: () => ({ lean: async () => ({ _id: 'S1', sellerId: 'SELLER' }) }) },
      storePageModel: { find: () => lean(opts.pages ?? []) },
      collectionTemplateModel: { find: () => lean(opts.templates ?? []) },
    },
  };
  return { service: new SavedSectionsService(model, db), model };
}

const textSection = { name: 'Free shipping bar', type: 'rich_text' as const, settings: { heading: 'Free shipping over $50' }, blocks: [] };

describe('assertSavedSectionContent', () => {
  it('accepts a normal section and the page-design settings', () => {
    expect(() => assertSavedSectionContent('rich_text', { heading: 'Hi', animation: 'fade' }, [])).not.toThrow();
  });
  it('refuses the page\'s own fixed parts and a reference to another saved section', () => {
    for (const t of ['product_main', 'cart_items', 'page_content', 'saved_section'] as const) {
      expect(() => assertSavedSectionContent(t, {}, [])).toThrow(BadRequestException);
    }
  });
  it('refuses a section that reads a custom field of one product (no owner to read it from)', () => {
    expect(() => assertSavedSectionContent('rich_text', { dynamicSourceNamespace: 'custom', dynamicSourceKey: 'x' }, [])).toThrow(BadRequestException);
  });
  it('runs the same setting checks as a page section', () => {
    expect(() => assertSavedSectionContent('rich_text', { paddingTop: 999 }, [])).toThrow(BadRequestException);
  });
});

describe('SavedSectionsService', () => {
  it('creates, lists (seller + public) and keeps the content', async () => {
    const { service } = makeService();
    const created: any = await service.create('S1', textSection);
    expect(created.data.name).toBe('Free shipping bar');
    expect(created.data.usedOn).toBe(0);
    const seller: any = await service.list('S1');
    expect(seller.data).toHaveLength(1);
    expect(seller.data[0].settings.heading).toBe('Free shipping over $50');
    const pub: any = await service.listPublic('S1');
    expect(pub.data[0]).not.toHaveProperty('usedOn');
    // another store sees nothing
    expect(((await service.listPublic('S2')) as any).data).toHaveLength(0);
  });

  it('needs a name, and names are unique per store (case-insensitive)', async () => {
    const { service } = makeService();
    await expect(service.create('S1', { ...textSection, name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('S1', { ...textSection, name: 'x'.repeat(61) })).rejects.toBeInstanceOf(BadRequestException);
    await service.create('S1', textSection);
    await expect(service.create('S1', { ...textSection, name: 'FREE SHIPPING BAR' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create('S2', textSection)).resolves.toBeTruthy();
  });

  it('stops at the library limit', async () => {
    const { service, model } = makeService();
    for (let i = 0; i < MAX_SAVED_SECTIONS; i++) model.rows.push({ _id: 'b'.repeat(23) + (i % 10), storeId: 'S1', nameKey: 'n' + i });
    await expect(service.create('S1', textSection)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update: rename and change content, but never the kind', async () => {
    const { service } = makeService();
    const created: any = await service.create('S1', textSection);
    const id = created.data._id;
    const renamed: any = await service.update('S1', id, { name: 'Shipping banner' });
    expect(renamed.data.name).toBe('Shipping banner');
    const edited: any = await service.update('S1', id, { settings: { heading: 'New text' }, blocks: [] });
    expect(edited.data.settings.heading).toBe('New text');
    await expect(service.update('S1', id, { type: 'hero' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('S1', id, { settings: { paddingTop: 999 } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('S2', id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('S1', 'not-an-id', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('counts where an entry is used (live and draft, pages and templates) and refuses to delete it then', async () => {
    const { service, model } = makeService({
      pages: [
        { sections: [], draft: { sections: [{ type: 'saved_section', settings: { savedSectionId: 'ID' } }] } },
        { sections: [{ type: 'saved_section', settings: { savedSectionId: 'ID' } }, { type: 'saved_section', settings: { savedSectionId: 'ID' } }], draft: { sections: [] } },
      ],
      templates: [{ sections: [{ type: 'saved_section', settings: { savedSectionId: 'OTHER' } }] }],
    });
    const created: any = await service.create('S1', textSection);
    const real = created.data._id;
    // point the fake pages at the real id
    for (const doc of [(service as any).databaseService.repositories.storePageModel]) void doc;
    const repos = (service as any).databaseService.repositories;
    repos.storePageModel.find = () => ({ select: () => ({ lean: async () => [
      { sections: [], draft: { sections: [{ type: 'saved_section', settings: { savedSectionId: real } }] } },
      { sections: [{ type: 'saved_section', settings: { savedSectionId: real } }, { type: 'saved_section', settings: { savedSectionId: real } }], draft: { sections: [] } },
    ] }) });
    const list: any = await service.list('S1');
    expect(list.data[0].usedOn).toBe(2); // two pages, a page counts once however many times it uses it
    await expect(service.remove('S1', real)).rejects.toBeInstanceOf(ConflictException);
    expect(model.rows).toHaveLength(1);
  });

  it('deletes an unused entry', async () => {
    const { service, model } = makeService();
    const created: any = await service.create('S1', textSection);
    await service.remove('S1', created.data._id);
    expect(model.rows).toHaveLength(0);
    await expect(service.remove('S1', created.data._id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('saved_section reference validation', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { validateSectionSettings } = require('../common/store-content/section-settings.validator');
  it('needs a real id and nothing else', () => {
    expect(() => validateSectionSettings('saved_section', { savedSectionId: 'a'.repeat(24) })).not.toThrow();
    expect(() => validateSectionSettings('saved_section', {})).toThrow(BadRequestException);
    expect(() => validateSectionSettings('saved_section', { savedSectionId: 'nope' })).toThrow(BadRequestException);
  });
});
