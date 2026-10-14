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
      moreMessages: [{ message: 'Two', ctaLabel: 'Shop', ctaLink: '/collections/sale' }, { message: '' }, { message: 'Three', hidden: true }],
      rotateSeconds: 8, closable: false, bgColor: '#112233', textColor: '#ffffff', placement: 'above', align: 'center', messageHidden: true,
    });
    expect(store.announcementBar.moreMessages).toEqual([
      { message: 'Two', ctaLabel: 'Shop', ctaLink: '/collections/sale', hidden: false, couponCode: null },
      { message: 'Three', ctaLabel: null, ctaLink: null, hidden: true, couponCode: null },
    ]);
    expect(store.announcementBar.messageHidden).toBe(true);
    expect(store.announcementBar).toMatchObject({ rotateSeconds: 8, closable: false, bgColor: '#112233', textColor: '#ffffff', placement: 'above', align: 'center' });
  });

  it('saves the design fields and falls back to the original look', async () => {
    const { update, store } = build();
    await update({ message: 'Sale', isActive: true, animation: 'marquee', fontSize: 'lg', uppercase: true, bgColor2: '#000000', device: 'mobile', couponCode: 'EID20', countdownEndAt: '2030-01-01T00:00:00Z' });
    expect(store.announcementBar).toMatchObject({ animation: 'marquee', fontSize: 'lg', uppercase: true, bgColor2: '#000000', device: 'mobile', couponCode: 'EID20', showIcon: true, dismissFor: 'forever' });
    await update({ message: 'Plain', isActive: true });
    expect(store.announcementBar).toMatchObject({ animation: 'slide', fontSize: 'sm', uppercase: false, bgColor2: null, device: 'all', couponCode: null, countdownEndAt: null });
  });

  it.each([
    ['an unknown animation', { message: 'a', animation: 'spin' }],
    ['a bad gradient colour', { message: 'a', bgColor2: 'blue' }],
    ['a bad countdown date', { message: 'a', countdownEndAt: 'soon' }],
  ])('rejects %s', async (_label, body) => {
    const { update } = build();
    await expect(update(body)).rejects.toThrow();
  });

  it.each([
    ['more than 9 extra messages', { message: 'a', moreMessages: Array(10).fill({ message: 'x' }) }],
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
