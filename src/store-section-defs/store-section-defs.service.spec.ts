import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StoreSectionDefsService, MAX_STORE_SECTION_DEFS } from './store-section-defs.service';

function makeService(opts: { pages?: any[]; saved?: any[] } = {}) {
  const rows: any[] = [];
  let seq = 0;
  const lean = <T,>(v: T) => ({ lean: async () => v, sort: () => ({ lean: async () => v }), select: () => ({ lean: async () => v }) });
  const model: any = {
    rows,
    find: (f: any) => lean(rows.filter(r => r.storeId === f.storeId)),
    exists: async (f: any) => rows.some(r => r.storeId === f.storeId && r.key === f.key),
    countDocuments: async (f: any) => rows.filter(r => r.storeId === f.storeId).length,
    create: async (d: any) => {
      if (rows.some(r => r.storeId === d.storeId && r.nameKey === d.nameKey)) throw Object.assign(new Error('dup'), { code: 11000 });
      const row = { _id: 'c'.repeat(23) + String(++seq), ...d };
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
  const savedModel: any = { find: () => lean(opts.saved ?? []) };
  const db: any = {
    repositories: {
      storeModel: { findOne: () => ({ lean: async () => ({ _id: 'S1', sellerId: 'SELLER' }) }) },
      storePageModel: { find: () => lean(opts.pages ?? []) },
      collectionTemplateModel: { find: () => lean([]) },
    },
  };
  return { service: new StoreSectionDefsService(model, savedModel, db), model };
}

const layout = (extra: unknown[] = []) => ({ t: 'stack', children: [{ t: 'heading', key: 'title', label: 'Title', default: 'Hi' }, ...extra] });

describe('StoreSectionDefsService', () => {
  it('creates a section: key from the name, fields derived, listed for seller and public', async () => {
    const { service } = makeService();
    const created: any = await service.create('S1', { name: 'Feature cards', description: 'Three cards', color: '#112233', layout: layout() });
    expect(created.data.key).toBe('my.feature-cards');
    expect(created.data.fields).toHaveLength(1);
    expect(created.data.defaults).toEqual({ title: 'Hi' });
    expect(created.data.usedOn).toBe(0);
    expect(((await service.list('S1')) as any).data).toHaveLength(1);
    const pub: any = await service.listPublic('S1');
    expect(pub.data[0]).not.toHaveProperty('usedOn');
    expect(((await service.listPublic('S2')) as any).data).toHaveLength(0);
  });

  it('refuses a bad layout, a missing name, a bad colour', async () => {
    const { service } = makeService();
    await expect(service.create('S1', { name: 'x', layout: { t: 'columns', children: [] } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('S1', { name: '  ', layout: layout() })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('S1', { name: 'ok', color: 'red', layout: layout() })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('S1', { name: 'a<b', layout: layout() })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('names are unique per store (case-insensitive); the key never collides', async () => {
    const { service } = makeService();
    await service.create('S1', { name: 'Hero text', layout: layout() });
    await expect(service.create('S1', { name: 'HERO TEXT', layout: layout() })).rejects.toBeInstanceOf(ConflictException);
    // different names that slug the same get a numbered key
    const second: any = await service.create('S1', { name: 'Hero-text!', layout: layout() });
    expect(second.data.key).toBe('my.hero-text-1');
  });

  it('stops at the limit', async () => {
    const { service, model } = makeService();
    for (let i = 0; i < MAX_STORE_SECTION_DEFS; i++) model.rows.push({ _id: 'd'.repeat(23) + (i % 10), storeId: 'S1', key: 'my.k' + i, nameKey: 'n' + i });
    await expect(service.create('S1', { name: 'one more', layout: layout() })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update keeps the key, re-derives the fields, and only touches its own store', async () => {
    const { service } = makeService();
    const created: any = await service.create('S1', { name: 'Banner', layout: layout() });
    const id = created.data._id;
    const next: any = await service.update('S1', id, { name: 'Big banner', layout: layout([{ t: 'text', key: 'body', label: 'Body' }]) });
    expect(next.data.key).toBe('my.banner');
    expect(next.data.name).toBe('Big banner');
    expect(next.data.fields.map((f: any) => f.key)).toEqual(['title', 'body']);
    await expect(service.update('S1', id, { layout: { t: 'columns', children: [] } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update('S2', id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('S1', 'nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('counts where it is used (pages, drafts, saved sections) and refuses to delete it then', async () => {
    const { service, model } = makeService({
      pages: [{ sections: [{ type: 'theme_section', settings: { sectionKey: 'my.banner' } }, { type: 'theme_section', settings: { sectionKey: 'my.banner' } }], draft: { sections: [] } }],
      saved: [{ settings: { sectionKey: 'my.banner' } }, { settings: { sectionKey: 'maison.lookbook' } }],
    });
    const created: any = await service.create('S1', { name: 'Banner', layout: layout() });
    const list: any = await service.list('S1');
    expect(list.data[0].usedOn).toBe(2); // one page (counted once) + one saved section
    await expect(service.remove('S1', created.data._id)).rejects.toBeInstanceOf(ConflictException);
    expect(model.rows).toHaveLength(1);
  });

  it('deletes an unused section', async () => {
    const { service, model } = makeService();
    const created: any = await service.create('S1', { name: 'Banner', layout: layout() });
    await service.remove('S1', created.data._id);
    expect(model.rows).toHaveLength(0);
    await expect(service.remove('S1', created.data._id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
