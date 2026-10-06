/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { importLocationsCsv } from './store-locations-bulk-import';

function setup(existing: string[] = [], limit = 99) {
  const names = new Set(existing.map((s) => s.toLowerCase()));
  const created: any[] = [];
  const deps: any = {
    locationModel: {
      findOne: jest.fn(async (q: any) => {
        for (const n of names) if (q.name.test(n)) return { _id: 'x', storeId: q.storeId };
        return null;
      }),
    },
    locationService: {
      createLocation: jest.fn(async (sellerId: string, storeId: string, dto: any) => {
        if (names.size >= limit) throw new BadRequestException('Your plan allows only ' + limit + ' locations');
        names.add(dto.name.toLowerCase());
        created.push({ sellerId, storeId, dto });
        return { data: {} };
      }),
    },
  };
  return { deps, created };
}

describe('locations bulk import', () => {
  it('creates locations through the service with mapped fields', async () => {
    const { deps, created } = setup();
    const res = await importLocationsCsv(deps, 'seller1', 'store1', 'Name,Type,City,Postcode,Latitude,Longitude\nMain,warehouse,Karachi,74000,24.8,67.0');
    expect(res.data.created).toBe(1);
    expect(created[0]).toMatchObject({ sellerId: 'seller1', storeId: 'store1', dto: { name: 'Main', type: 'warehouse', city: 'Karachi', zipCode: '74000', latitude: 24.8, longitude: 67 } });
  });

  it('skips existing names (case-insensitive) and fails duplicates inside the file', async () => {
    const { deps } = setup(['Main']);
    const res = await importLocationsCsv(deps, 's', 'store1', 'Name\nMAIN\nShop\nshop');
    expect(res.data).toMatchObject({ skipped: 1, created: 1, failedCount: 1 });
  });

  it('reports the plan-limit message on the row and validates type / coordinates', async () => {
    const { deps } = setup(['Existing'], 1);
    const res = await importLocationsCsv(deps, 's', 'store1', 'Name,Type,Latitude,Longitude\nNew,store,,\nBad,moon,,\nGeo,store,95,10\nHalf,store,10,');
    const errs = res.data.failed.map((f) => f.error);
    expect(errs[0]).toContain('plan allows');
    expect(errs[1]).toContain('Type');
    expect(errs[2]).toContain('Latitude');
    expect(errs[3]).toContain('both');
  });

  it('requires the Name column', async () => {
    const { deps } = setup();
    await expect(importLocationsCsv(deps, 's', 'store1', 'City\nX')).rejects.toThrow('Name');
  });
});
