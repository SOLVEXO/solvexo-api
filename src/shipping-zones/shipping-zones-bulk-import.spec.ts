/* eslint-disable prettier/prettier */
import { importShippingZonesCsv, resolveImportCountry, SHIPPING_ZONE_IMPORT_COLUMNS } from './shipping-zones-bulk-import';

function setup(existing: any[] = []) {
  const created: any[] = [];
  return {
    created,
    deps: {
      listExisting: async () => existing,
      create: async (dto: any) => { created.push(dto); },
    },
  };
}

const HEADER = 'Country,Province/State,City,Zone Name,Shipping Price,Free Shipping Threshold,Estimated Delivery,Status';

describe('shipping zones bulk import', () => {
  it('creates valid flat-rate zones and reports invalid rows with the column', async () => {
    const s = setup();
    const csv = [
      HEADER,
      'Pakistan,Punjab,Lahore,Express,300,5000,3-5 Days,active',
      'Atlantis,,,,100,,,',
      'Pakistan,Sindh,,,abc,,,',
      'Pakistan,Balochistan,,,100,,,paused',
      'PK,KPK,,,-5,,,',
    ].join('\n');
    const res = await importShippingZonesCsv(s.deps, csv);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(4);
    expect(res.data.failed[0].error).toContain('Country');
    expect(res.data.failed[1].error).toContain('Shipping Price');
    expect(res.data.failed[2].error).toContain('Status');
    expect(s.created[0]).toMatchObject({ country: 'Pakistan', province: 'Punjab', city: 'Lahore', shippingPrice: 300, rateType: 'flat', zoneType: 'shipping', freeShippingThreshold: 5000, status: 'active' });
  });

  it('accepts an ISO code and stores the English name', () => {
    expect(resolveImportCountry('pk')).toBe('Pakistan');
    expect(resolveImportCountry('Pakistan')).toBe('Pakistan');
  });

  it('skips an existing zone (case-insensitive) in the default profile, but not one in another profile / other type', async () => {
    const s = setup([
      { country: 'Pakistan', province: 'punjab', city: 'LAHORE', zoneType: 'shipping', profileId: null },
      { country: 'India', province: null, city: null, zoneType: 'shipping', profileId: 'abc123' },
      { country: 'Nepal', province: null, city: null, zoneType: 'pickup', profileId: null },
    ]);
    const csv = [HEADER, 'Pakistan,Punjab,Lahore,,100,,,', 'India,,,,100,,,', 'Nepal,,,,100,,,'].join('\n');
    const res = await importShippingZonesCsv(s.deps, csv);
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(2);
    expect(s.created.length).toBe(2);
  });

  it('fails the second row when country+province+city repeats in the file', async () => {
    const s = setup();
    const res = await importShippingZonesCsv(s.deps, [HEADER, 'Pakistan,Punjab,,,100,,,', 'pakistan,punjab,,,200,,,'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate');
  });

  it('only sees the zones given by the store-scoped listing (store scoping) and enforces required columns', async () => {
    // listExisting is bound to ONE store by the controller; another store's zone is simply not in it.
    const s = setup([]);
    const res = await importShippingZonesCsv(s.deps, [HEADER, 'Pakistan,,,,100,,,'].join('\n'));
    expect(res.data.created).toBe(1);
    await expect(importShippingZonesCsv(s.deps, 'Country\nPakistan')).rejects.toThrow('Shipping Price');
    expect(SHIPPING_ZONE_IMPORT_COLUMNS.filter((c) => c.required).length).toBe(2);
  });
});
