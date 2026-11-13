/* eslint-disable prettier/prettier */
import { StoreContactService } from './store-contact.service';

function make(msgs: any[], stats: any[]) {
  const svc: any = Object.create(StoreContactService.prototype);
  const updates: any[] = [];
  let calls = 0;
  svc.databaseService = { repositories: { storeContactMessageModel: { aggregate: async () => (++calls === 1 ? msgs : [{ _id: '2026-11-01', n: 4 }]) }, storeModel: { findById: async () => ({ _id: 's1', sellerId: 'u1', isDelete: false }), exists: async () => ({ _id: 's1' }) } } };
  svc.stats = { find: () => ({ limit: () => ({ lean: async () => stats }) }), updateOne: async (...a: any[]) => { updates.push(a); } };
  return { svc: svc as StoreContactService, updates };
}
const SEC = 'a'.repeat(24);

describe('form report and counters', () => {
  it('adds views, starts, sent, spam and sources per form', async () => {
    const { svc } = make(
      [{ _id: { s: SEC, src: 'search', spam: false }, n: 3, name: 'Quote' }, { _id: { s: SEC, src: 'direct', spam: false }, n: 1, name: 'Quote' }, { _id: { s: SEC, src: 'unknown', spam: true }, n: 2, name: 'Quote' }],
      [{ sectionId: SEC, day: '2026-11-01', views: 40, starts: 9, fields: { em: 9, ms: 5 } }],
    );
    const res: any = await svc.report('s1', 'u1', 30);
    const f = res.data.forms[0];
    expect(f.name).toBe('Quote');
    expect(f.views).toBe(40); expect(f.starts).toBe(9); expect(f.sent).toBe(4); expect(f.spam).toBe(2);
    expect(f.fieldTouches.em).toBe(9); expect(f.fieldTouches.ms).toBe(5);
    expect(res.data.daily).toEqual([{ day: '2026-11-01', views: 40, sent: 4 }]);
    expect(f.sources.search).toBe(3); expect(f.sources.direct).toBe(1);
  });
  it('counts a view or start only for a real section id and a known kind', async () => {
    const { svc, updates } = make([], []);
    await svc.trackEvent('s1', SEC, 'view');
    await svc.trackEvent('s1', SEC, 'start');
    await svc.trackEvent('s1', 'bad', 'view');
    await svc.trackEvent('s1', SEC, 'delete');
    expect(updates.length).toBe(2);
    expect(JSON.stringify(updates[0][1])).toContain('views');
    expect(JSON.stringify(updates[1][1])).toContain('starts');
  });
});
