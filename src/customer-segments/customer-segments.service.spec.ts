/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CustomerSegmentsService, MAX_SEGMENTS_PER_STORE } from './customer-segments.service';

const q = (v: any) => { const o: any = { select: () => o, lean: () => o, sort: () => o, limit: () => o, then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return o; };
const OID = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

function setup() {
  const docs: any[] = []; let n = 0;
  const match = (d: any, f: any) => Object.entries(f).every(([k, v]: [string, any]) => {
    if (v instanceof RegExp) return v.test(d[k]);
    if (v && typeof v === 'object' && '$ne' in v) return String(d[k]) !== String(v.$ne);
    return String(d[k]) === String(v);
  });
  const model: any = {
    find: (f: any) => q(docs.filter((d) => match(d, f))),
    findOne: (f: any) => q(docs.find((d) => match(d, f)) ?? null),
    exists: async (f: any) => docs.some((d) => match(d, f)),
    countDocuments: async (f: any) => docs.filter((d) => match(d, f)).length,
    create: async (data: any) => { const d = { _id: OID(++n), createdAt: new Date(), ...data }; docs.push(d); return { ...d, toObject: () => d }; },
    findOneAndUpdate: (f: any, u: any) => { const d = docs.find((x) => match(x, f)); if (d) Object.assign(d, u.$set); return q(d ?? null); },
    deleteOne: async (f: any) => { const i = docs.findIndex((x) => match(x, f)); if (i >= 0) docs.splice(i, 1); },
  };
  const stores: any = { s1: { _id: 's1', sellerId: 'sel1' }, s2: { _id: 's2', sellerId: 'sel2' } };
  const db: any = { repositories: { customerSegmentModel: model, storeModel: { findById: async (id: string) => stores[id] ?? null } } };
  const storeService: any = { querySegmentMembers: jest.fn().mockImplementation(async (_s: string, _c: any, o: any) => (o.mode === 'count' ? 3 : o.mode === 'ids' ? [{ _id: 'u1', email: 'A@x.com' }] : { customers: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } })) };
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  return { svc: new CustomerSegmentsService(db, storeService, activity), docs, storeService, activity };
}
const filter = { conditions: [{ field: 'amount_spent', op: 'gt', value: 100 }] };

describe('CustomerSegmentsService', () => {
  it('creates, lists, updates, duplicates and deletes within one store', async () => {
    const { svc, activity } = setup();
    const c = await svc.create('s1', 'sel1', { name: 'Big spenders', filter });
    expect((await svc.list('s1', 'sel1')).data.segments).toHaveLength(1);
    await svc.update('s1', 'sel1', c.data.id, { name: 'Whales' });
    const dup = await svc.duplicate('s1', 'sel1', c.data.id);
    expect(dup.data.name).toBe('Whales (copy)');
    await svc.remove('s1', 'sel1', c.data.id);
    expect((await svc.list('s1', 'sel1')).data.segments).toHaveLength(1);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ category: 'customers', action: 'segment_created' }));
  });

  it('refuses another seller\'s store and another store\'s segment (isolation)', async () => {
    const { svc } = setup();
    const c = await svc.create('s1', 'sel1', { name: 'A', filter });
    await expect(svc.list('s1', 'sel2')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.create('s1', 'sel2', { name: 'B', filter })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.get('s2', 'sel2', c.data.id)).rejects.toBeInstanceOf(NotFoundException); // s1's segment id via s2
    await expect(svc.members('s2', 'sel2', c.data.id, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.exportCsv('s2', 'sel2', c.data.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove('s2', 'sel2', c.data.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects bad names, duplicate names (case-insensitive), bad filters and the per-store cap', async () => {
    const { svc, docs } = setup();
    await expect(svc.create('s1', 'sel1', { name: '  ', filter })).rejects.toBeInstanceOf(BadRequestException);
    await svc.create('s1', 'sel1', { name: 'VIP', filter });
    await expect(svc.create('s1', 'sel1', { name: 'vip', filter })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create('s1', 'sel1', { name: 'X', filter: { conditions: [{ field: '$where', op: 'eq', value: 1 }] } })).rejects.toBeInstanceOf(BadRequestException);
    for (let i = docs.length; i < MAX_SEGMENTS_PER_STORE; i++) docs.push({ _id: OID(90 + i), storeId: 's1', name: `n${i}`, filter });
    await expect(svc.create('s1', 'sel1', { name: 'one too many', filter })).rejects.toThrow(/up to 50/);
  });

  it('preview/count/members evaluate live through the store pipeline (no snapshot) and cap page size', async () => {
    const { svc, storeService } = setup();
    expect((await svc.preview('s1', 'sel1', filter)).data.count).toBe(3);
    const c = await svc.create('s1', 'sel1', { name: 'A', filter });
    expect((await svc.count('s1', 'sel1', c.data.id)).data.count).toBe(3);
    await svc.members('s1', 'sel1', c.data.id, { page: '2', limit: '999', search: 'ali' });
    expect(storeService.querySegmentMembers).toHaveBeenLastCalledWith('s1', expect.anything(), { mode: 'list', page: 2, limit: 999, search: 'ali' });
    await expect(svc.preview('s1', 'sel1', { conditions: [{ field: 'amount_spent', op: 'gt', value: { $ne: 1 } }] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('export is scoped to the segment\'s store and returns CSV', async () => {
    const { svc, storeService } = setup();
    storeService.querySegmentMembers.mockResolvedValueOnce({ customers: [{ name: 'Ali', email: 'a@x.com', orderCount: 2, totalSpent: 300, tags: ['vip'] }], pagination: { totalPages: 1 } });
    const c = await svc.create('s1', 'sel1', { name: 'My Segment!', filter });
    const out = await svc.exportCsv('s1', 'sel1', c.data.id);
    expect(out.filename).toBe('segment-my-segment-.csv');
    expect(out.csv).toContain('a@x.com');
    expect(storeService.querySegmentMembers.mock.calls.every((c: any[]) => c[0] === 's1')).toBe(true);
  });

  it('audience helpers: members by id/email, deleted segment => null, membership for one customer', async () => {
    const { svc, storeService } = setup();
    const c = await svc.create('s1', 'sel1', { name: 'A', filter });
    const m = await svc.resolveMembers('s1', c.data.id);
    expect([...m!.ids]).toEqual(['u1']);
    expect([...m!.emails]).toEqual(['a@x.com']);
    expect(await svc.resolveMembers('s2', c.data.id)).toBeNull(); // other store's segment is invisible
    expect(await svc.isMember('s1', c.data.id, 'u1')).toBe(true); // count mock = 3
    expect(storeService.querySegmentMembers).toHaveBeenLastCalledWith('s1', expect.anything(), { mode: 'count', onlyCustomerId: 'u1' });
    expect(await svc.isMember('s1', 'not-an-id', 'u1')).toBe(false);
  });
});
