/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { StoreService } from './store.service';

function build() {
  const store: any = { _id: 's1', sellerId: 'seller', isDelete: false, announcementBar: null, save: jest.fn().mockResolvedValue(undefined) };
  const service: any = Object.create(StoreService.prototype);
  service.databaseService = { repositories: { storeModel: { findOne: jest.fn().mockResolvedValue(store) } } };
  service.activityLogService = { log: jest.fn() };
  const update = (body: any) => service.updateAnnouncementBar('seller', 's1', body);
  return { update, store };
}

describe('announcement bar settings', () => {
  it('saves the new fields and keeps the old single-message bar working', async () => {
    const { update, store } = build();
    await update({ message: 'Free shipping', isActive: true });
    expect(store.announcementBar).toMatchObject({
      message: 'Free shipping', type: 'info', isActive: true, moreMessages: [], rotateSeconds: 5, closable: true,
      bgColor: null, textColor: null, placement: 'below', align: 'left',
    });
  });

  it('stores extra rotating messages (dropping empty ones) and the look settings', async () => {
    const { update, store } = build();
    await update({
      message: 'One', isActive: true,
      moreMessages: [{ message: 'Two', ctaLabel: 'Shop', ctaLink: '/collections/sale' }, { message: '' }, { message: 'Three' }],
      rotateSeconds: 8, closable: false, bgColor: '#112233', textColor: '#ffffff', placement: 'above', align: 'center',
    });
    expect(store.announcementBar.moreMessages).toEqual([
      { message: 'Two', ctaLabel: 'Shop', ctaLink: '/collections/sale' },
      { message: 'Three', ctaLabel: null, ctaLink: null },
    ]);
    expect(store.announcementBar).toMatchObject({ rotateSeconds: 8, closable: false, bgColor: '#112233', textColor: '#ffffff', placement: 'above', align: 'center' });
  });

  it.each([
    ['more than 4 extra messages', { message: 'a', moreMessages: Array(5).fill({ message: 'x' }) }],
    ['an unsafe extra-message link', { message: 'a', moreMessages: [{ message: 'b', ctaLink: 'javascript:alert(1)' }] }],
    ['an unsafe main link', { message: 'a', ctaLink: 'javascript:alert(1)' }],
    ['a protocol-relative link', { message: 'a', ctaLink: '//evil.example' }],
    ['a rotate time out of range', { message: 'a', rotateSeconds: 1 }],
    ['a non-hex colour', { message: 'a', bgColor: 'red' }],
    ['a bad placement', { message: 'a', placement: 'middle' }],
    ['a bad alignment', { message: 'a', align: 'right' }],
    ['a too-long message', { message: 'x'.repeat(201) }],
  ])('rejects %s', async (_label, body) => {
    const { update, store } = build();
    await expect(update(body)).rejects.toThrow(BadRequestException);
    expect(store.save).not.toHaveBeenCalled();
  });
});
