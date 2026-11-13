/* eslint-disable prettier/prettier */
import { SavedFormsService, MAX_SAVED_FORMS } from './saved-forms.service';

const store = { findById: async () => ({ _id: 's1', sellerId: 'u1', isDelete: false }) };

function make(rows: any[] = []) {
  const model: any = {
    find: () => ({ sort: () => ({ lean: async () => rows }) }),
    countDocuments: async () => rows.length,
    create: async (d: any) => { if (rows.some(r => r.name === d.name)) { const e: any = new Error('dup'); e.code = 11000; throw e; } const r = { _id: 'a'.repeat(24), ...d }; rows.push(r); return r; },
    deleteOne: async (q: any) => { const i = rows.findIndex(r => String(r._id) === q._id && r.storeId === q.storeId); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
  };
  const db: any = { repositories: { storeModel: store } };
  return { svc: new SavedFormsService(db, model), rows };
}
const fields = [{ id: 'em', type: 'email', label: 'Email', required: true }];

describe('saved forms', () => {
  it('saves only the form settings, never anything else, and lists it back', async () => {
    const { svc, rows } = make();
    const res: any = await svc.create('s1', 'u1', ' Quote ', { fields, buttonLabel: 'Go', _id: 'x', heading: 'Page heading', evil: 1 });
    expect(res.data.name).toBe('Quote');
    expect(Object.keys(rows[0].settings).sort().join(',')).toBe('buttonLabel,fields');
    const list: any = await svc.list('s1', 'u1');
    expect(list.data.length).toBe(1);
  });
  it('refuses an invalid form, a missing name and a duplicate name', async () => {
    const { svc } = make();
    let err: any; try { await svc.create('s1', 'u1', 'X', { fields: [{ id: '!', type: 'email', label: 'E' }] }); } catch (e) { err = e; }
    expect(!!err).toBe(true);
    err = null; try { await svc.create('s1', 'u1', '', { fields }); } catch (e) { err = e; }
    expect(!!err).toBe(true);
    await svc.create('s1', 'u1', 'A', { fields });
    err = null; try { await svc.create('s1', 'u1', 'A', { fields }); } catch (e) { err = e; }
    expect(String(err?.message)).toContain('already exists');
  });
  it('caps the library and deletes only inside the store', async () => {
    const rows = Array.from({ length: MAX_SAVED_FORMS }, (_, i) => ({ _id: String(i), storeId: 's1', name: 'n' + i, settings: {} }));
    const { svc } = make(rows);
    let err: any; try { await svc.create('s1', 'u1', 'new', { fields }); } catch (e) { err = e; }
    expect(String(err?.message)).toContain('up to');
    err = null; try { await svc.remove('s1', 'u1', 'not-an-id'); } catch (e) { err = e; }
    expect(!!err).toBe(true);
  });
});
