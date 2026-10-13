/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));

import { MenusService } from './menus.service';

function build() {
  let created: any = null;
  const menuModel: any = {
    countDocuments: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation((doc: any) => { created = doc; return Promise.resolve(doc); }),
  };
  const storeModel: any = { findById: jest.fn().mockResolvedValue({ sellerId: 'seller', isDelete: false }) };
  const service = new MenusService({ repositories: { menuModel, storeModel } } as any);
  return { service, getCreated: () => created };
}

describe('menu item ids', () => {
  it('replaces editor-made "new-" ids (also on nested children) with real ids and keeps real ones', async () => {
    const { service, getCreated } = build();
    await service.create('s1', 'seller', {
      name: 'Main',
      items: [
        { id: 'new-123-abc', label: 'Shop', linkType: 'home', children: [{ id: 'new-999', label: 'Sub', linkType: 'home' }] },
        { id: '507f1f77bcf86cd799439011', label: 'About', linkType: 'home' },
        { label: 'Blank id', linkType: 'home' },
      ],
    } as any);
    const [a, b, c] = getCreated().items;
    expect(a.id).not.toMatch(/^new-/);
    expect(a.children[0].id).not.toMatch(/^new-/);
    expect(b.id).toBe('507f1f77bcf86cd799439011');
    expect(c.id).toMatch(/^[0-9a-f]{24}$/);
  });
});
