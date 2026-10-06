import { GENERAL_GROUP_KEY, addressRequired, groupItemsByProfile, haversineKm, normalizeSelections, radiusMatch, zoneInGroup } from './shipping-profile.util';

describe('groupItemsByProfile', () => {
  const items = [
    { productId: 'a', type: 'physical' },
    { productId: 'b', type: 'physical' },
    { productId: 'c', type: 'digital' },
    { productId: 'd', type: 'physical' },
  ];
  it('puts everything in General when no custom profile exists', () => {
    const g = groupItemsByProfile(items, new Map(), new Set());
    expect([...g.keys()]).toEqual([GENERAL_GROUP_KEY]);
    expect(g.get(GENERAL_GROUP_KEY)!.map((i) => i.productId)).toEqual(['a', 'b', 'd']);
  });
  it('splits by profile and ignores digital lines', () => {
    const g = groupItemsByProfile(items, new Map([['b', 'p1'], ['c', 'p1']]), new Set(['p1']));
    expect(g.get('p1')!.map((i) => i.productId)).toEqual(['b']);
    expect(g.get(GENERAL_GROUP_KEY)!.map((i) => i.productId)).toEqual(['a', 'd']);
  });
  it('falls back to General for a deleted / unknown profile', () => {
    const g = groupItemsByProfile(items, new Map([['a', 'gone']]), new Set(['p1']));
    expect([...g.keys()]).toEqual([GENERAL_GROUP_KEY]);
  });
});

describe('zoneInGroup', () => {
  it('treats a missing profileId as General', () => {
    expect(zoneInGroup({}, GENERAL_GROUP_KEY)).toBe(true);
    expect(zoneInGroup({ profileId: null }, GENERAL_GROUP_KEY)).toBe(true);
    expect(zoneInGroup({ profileId: 'p1' }, GENERAL_GROUP_KEY)).toBe(false);
    expect(zoneInGroup({ profileId: 'p1' }, 'p1')).toBe(true);
  });
});

describe('normalizeSelections', () => {
  it('accepts the legacy single zone id for one group', () => {
    const r: any = normalizeSelections([GENERAL_GROUP_KEY], { shippingZoneId: 'z1' });
    expect(r.byGroup.get(GENERAL_GROUP_KEY)).toBe('z1');
  });
  it('rejects the legacy id when there are several groups', () => {
    expect(normalizeSelections([GENERAL_GROUP_KEY, 'p1'], { shippingZoneId: 'z1' })).toHaveProperty('error');
  });
  it('requires one selection per group, no duplicates, no foreign groups', () => {
    const keys = [GENERAL_GROUP_KEY, 'p1'];
    expect(normalizeSelections(keys, { selections: [{ shippingZoneId: 'z1' }] })).toHaveProperty('error');
    expect(normalizeSelections(keys, { selections: [{ shippingZoneId: 'z1' }, { shippingZoneId: 'z2' }] })).toHaveProperty('error');
    expect(normalizeSelections(keys, { selections: [{ shippingZoneId: 'z1' }, { profileId: 'zzz', shippingZoneId: 'z2' }] })).toHaveProperty('error');
    const ok: any = normalizeSelections(keys, { selections: [{ shippingZoneId: 'z1' }, { profileId: 'p1', shippingZoneId: 'z2' }] });
    expect(ok.byGroup.get('p1')).toBe('z2');
  });
});

describe('addressRequired', () => {
  it('is only skipped when every group picked pickup', () => {
    expect(addressRequired(['pickup'])).toBe(false);
    expect(addressRequired(['pickup', 'pickup'])).toBe(false);
    expect(addressRequired(['pickup', 'shipping'])).toBe(true);
    expect(addressRequired([])).toBe(true);
  });
});

describe('radiusMatch', () => {
  const karachi = { latitude: 24.8607, longitude: 67.0011 };
  const near = { latitude: 24.87, longitude: 67.01 };
  const lahore = { latitude: 31.5204, longitude: 74.3587 };
  it('computes haversine distance', () => {
    expect(haversineKm(karachi, lahore)).toBeGreaterThan(1000);
    expect(haversineKm(karachi, karachi)).toBeCloseTo(0, 5);
  });
  it('is null when it cannot be evaluated', () => {
    expect(radiusMatch({}, karachi, near)).toBeNull();
    expect(radiusMatch({ radiusKm: 10 }, null, near)).toBeNull();
    expect(radiusMatch({ radiusKm: 10 }, karachi, { latitude: null, longitude: null })).toBeNull();
  });
  it('checks the radius', () => {
    expect(radiusMatch({ radiusKm: 10 }, karachi, near)).toBe(true);
    expect(radiusMatch({ radiusKm: 10 }, karachi, lahore)).toBe(false);
  });
});
