/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));
jest.mock('../admin-config/admin-config.service', () => ({ AdminConfigService: class {} }));
jest.mock('../media-library/media-library.service', () => ({ MediaLibraryService: class {} }));
jest.mock('../activity-log/activity-log.service', () => ({ ActivityLogService: class {} }));
jest.mock('../platform-plans/entitlements.service', () => ({ EntitlementsService: class {} }));

import { StoreBannerService } from './store-banner.service';

const HOUR = 3_600_000;
const future = () => new Date(Date.now() + 24 * HOUR).toISOString();

function build(banner: any) {
  const updates: any[] = [];
  let capturedFilter: any = null;
  const storeBannerModel: any = {
    findOne: jest.fn().mockResolvedValue(banner),
    findByIdAndUpdate: jest.fn().mockImplementation((_id: string, update: any) => { updates.push(update.$set); return Promise.resolve({ ...banner, ...update.$set }); }),
    find: jest.fn().mockImplementation((filter: any) => {
      capturedFilter = filter;
      const chain: any = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve([]) };
      return chain;
    }),
  };
  const storeModel: any = { findOne: jest.fn().mockResolvedValue({ _id: 's1' }) };
  const db: any = { repositories: { storeBannerModel, storeModel } };
  const adminConfig: any = { getPlacementLimit: jest.fn().mockResolvedValue(4) };
  const activity: any = { log: jest.fn() };
  const service = new StoreBannerService(db, adminConfig, {} as any, activity, {} as any);
  return { service, updates, getFilter: () => capturedFilter };
}

describe('store banner scheduling', () => {
  it('shows scheduled banners once their start date passes (query accepts status scheduled)', async () => {
    const { service, getFilter } = build({});
    await service.findActiveForStore('s1');
    expect(getFilter().status).toEqual({ $in: ['active', 'scheduled'] });
  });

  it('scheduling an active banner for the future marks it scheduled', async () => {
    const { service, updates } = build({ status: 'active', startAt: null, endAt: null });
    await service.update('s1', 'seller', 'b1', { startAt: future() } as any);
    expect(updates[0].status).toBe('scheduled');
  });

  it('editing the schedule of a paused banner does not un-pause it', async () => {
    const { service, updates } = build({ status: 'paused', startAt: null, endAt: null });
    await service.update('s1', 'seller', 'b1', { endAt: future() } as any);
    expect(updates[0].status).toBeUndefined();
  });

  it('null clears a date and the banner goes live again', async () => {
    const { service, updates } = build({ status: 'scheduled', startAt: new Date(Date.now() + 24 * HOUR), endAt: null });
    await service.update('s1', 'seller', 'b1', { startAt: null } as any);
    expect(updates[0].startAt).toBeNull();
    expect(updates[0].status).toBe('active');
  });

  it('editing only the end date keeps the stored start date', async () => {
    const { service, updates } = build({ status: 'scheduled', startAt: new Date(Date.now() + 24 * HOUR), endAt: null });
    await service.update('s1', 'seller', 'b1', { endAt: new Date(Date.now() + 72 * HOUR).toISOString() } as any);
    expect(updates[0].status).toBe('scheduled');
  });
});

describe('seller banner list reports the status the storefront applies', () => {
  const rows = (): any[] => [
    { _id: 'a', status: 'active', endAt: new Date(Date.now() - HOUR) },
    { _id: 'b', status: 'scheduled', startAt: new Date(Date.now() - HOUR) },
    { _id: 'c', status: 'scheduled', startAt: new Date(Date.now() + 24 * HOUR) },
    { _id: 'd', status: 'paused', endAt: new Date(Date.now() - HOUR) },
    { _id: 'e', status: 'active', endAt: new Date(Date.now() + 24 * HOUR) },
  ];
  it('flags expired, activates started-scheduled, leaves paused/future/live untouched', async () => {
    const { service } = build({});
    (service as any).storeBannerModel.find = () => { const c: any = { sort: () => c, lean: () => Promise.resolve(rows()) }; return c; };
    const out: any = await service.listForSeller('s1', 'seller1');
    const st = Object.fromEntries(out.data.map((b: any) => [b._id, b.status]));
    expect(st).toEqual({ a: 'expired', b: 'active', c: 'scheduled', d: 'paused', e: 'active' });
  });
});
