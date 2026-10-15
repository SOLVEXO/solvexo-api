import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TranslationsService } from './translations.service';

const STORE = '64b0000000000000000000a1';
const ID = '64b0000000000000000000b1';

const chain = (value: any) => {
  const q: any = { select: () => q, sort: () => q, skip: () => q, limit: () => q, lean: () => Promise.resolve(value) };
  return q;
};

function make(models: Record<string, any>) {
  return new TranslationsService({ repositories: models } as any);
}

describe('TranslationsService', () => {
  it('saves a product translation scoped to the store and returns the item', async () => {
    const productModel = {
      findOneAndUpdate: jest.fn(() => chain({ _id: ID, name: 'Shirt', description: 'Nice', slug: 'shirt', translations: { ur: { _id: 'x', locale: 'ur', title: 'قمیض' } } })),
    };
    const out = await make({ productModel }).save(STORE, 'products', ID, 'UR', { title: ' قمیض ', handle: 'qameez' });
    const [filter, update] = productModel.findOneAndUpdate.mock.calls[0] as any[];
    expect(filter).toEqual({ storeId: STORE, _id: ID, isDelete: false });
    expect(update.$set['translations.ur']).toMatchObject({ locale: 'ur', title: 'قمیض', handle: 'qameez' });
    expect(out.translations.ur).toEqual({ locale: 'ur', title: 'قمیض' }); // internal _id stripped
    expect(out.source).toEqual({ title: 'Shirt', description: 'Nice', handle: 'shirt' });
  });

  it('refuses English, bad locales, bad ids, empty titles and bad handles', async () => {
    const svc = make({ productModel: { findOneAndUpdate: jest.fn() } });
    await expect(svc.save(STORE, 'products', ID, 'en', { title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save(STORE, 'products', ID, '../x', { title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save(STORE, 'products', 'nope', 'ur', { title: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save(STORE, 'products', ID, 'ur', { title: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.save(STORE, 'products', ID, 'ur', { title: 'x', handle: 'a b/c' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("404s for another store's product (no match)", async () => {
    const productModel = { findOneAndUpdate: jest.fn(() => chain(null)) };
    await expect(make({ productModel }).save(STORE, 'products', ID, 'ur', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists with search escaped and page size capped', async () => {
    const find = jest.fn(() => chain([{ _id: ID, name: 'A', slug: 'a', description: '', translations: {} }]));
    const collectionModel = { find, countDocuments: jest.fn().mockResolvedValue(1) };
    const out = await make({ collectionModel }).list(STORE, 'collections', { page: '1', limit: '9999', q: 'a.*(' });
    expect((find.mock.calls[0] as any[])[0]).toEqual({ storeId: STORE, isDelete: false, name: { $regex: 'a\\.\\*\\(', $options: 'i' } });
    expect(out.pagination.limit).toBe(50);
    expect(out.items).toHaveLength(1);
  });

  it('writes and clears menu item labels, including nested items, and rejects unknown ids', async () => {
    const menu = { _id: ID, name: 'Main', items: [{ id: 'a', label: 'Shop', labelTranslations: { ur: 'old' }, children: [{ id: 'b', label: 'Shoes' }] }] };
    const menuModel = {
      findOne: jest.fn(() => chain(menu)),
      findOneAndUpdate: jest.fn((_f: any, update: any) => chain({ ...menu, items: update.$set.items })),
    };
    const svc = make({ menuModel });
    const out = await svc.save(STORE, 'menus', ID, 'ur', { labels: { a: '', b: 'جوتے' } });
    const items = (menuModel.findOneAndUpdate.mock.calls[0] as any[])[1].$set.items;
    expect(items[0].labelTranslations).toEqual({});
    expect(items[0].children[0].labelTranslations).toEqual({ ur: 'جوتے' });
    expect(out.menuItems!.map((i: any) => [i.id, i.depth])).toEqual([['a', 0], ['b', 1]]);
    await expect(svc.save(STORE, 'menus', ID, 'ur', { labels: { zzz: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes a language with $unset', async () => {
    const pageModel = { updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) };
    await make({ storePageModel: pageModel }).remove(STORE, 'pages', ID, 'ur');
    expect((pageModel.updateOne.mock.calls[0] as any[])[1]).toEqual({ $unset: { 'translations.ur': '' } });
    pageModel.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(make({ storePageModel: pageModel }).remove(STORE, 'pages', ID, 'ur')).rejects.toBeInstanceOf(NotFoundException);
  });
});
