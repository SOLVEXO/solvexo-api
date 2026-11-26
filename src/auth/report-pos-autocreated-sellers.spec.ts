/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { findAutoCreatedSellers, parseArgs } from '../../scripts/report-pos-autocreated-sellers';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';

jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

describe('parseArgs', () => {
  it('accepts --since in both forms', () => {
    expect(parseArgs(['--since=2026-10-01']).since.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parseArgs(['--since', '2026-10-01']).since.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
  it('requires a valid date', () => {
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['--since=yesterday'])).toThrow(/Usage/);
  });
  it.each(['--write', '--delete', '--fix', '--apply', '--update', '--drop', '--force', '--execute'])('refuses the write flag %s', (flag) => {
    expect(() => parseArgs(['--since=2026-10-01', flag])).toThrow(/write flag/);
    expect(() => parseArgs([flag, '--since=2026-10-01'])).toThrow(/write flag/);
  });
  it('refuses any unknown argument', () => {
    expect(() => parseArgs(['--since=2026-10-01', '--verbose'])).toThrow(/Unknown argument/);
  });
});

describe('findAutoCreatedSellers (real Mongo)', () => {
  const seller = async (o: any) => {
    const _id = new Types.ObjectId();
    await h.repos.sellerModel.collection.insertOne({ _id, name: 'x', email: `${_id}@x.com`, role: 'seller', createdAt: new Date('2026-11-01'), ...o });
    return String(_id);
  };

  it('lists only google/apple sellers with no password and no store, created since the date; writes nothing', async () => {
    const hit1 = await seller({ authProvider: 'google', providerId: 'g1' });
    const hit2 = await seller({ authProvider: 'apple', providerId: 'a1', password: '' });
    await seller({ authProvider: 'google', password: 'hash' });                       // has a password
    const withStore = await seller({ authProvider: 'google' });                        // has a store
    await h.repos.storeModel.collection.insertOne({ sellerId: withStore, name: 'S', slug: 's' });
    await seller({ authProvider: 'facebook' });                                        // other provider
    await seller({});                                                                  // email signup
    await seller({ authProvider: 'google', createdAt: new Date('2026-09-01') });       // too old

    const before = { s: await h.repos.sellerModel.countDocuments({}), st: await h.repos.storeModel.countDocuments({}) };
    const res = await findAutoCreatedSellers(h.conn.db, new Date('2026-10-01'));
    expect(res.count).toBe(2);
    expect(res.rows.map((r) => r.id).sort()).toEqual([hit1, hit2].sort());
    expect(Object.keys(res.rows[0]).sort()).toEqual(['createdAt', 'email', 'id']);
    expect({ s: await h.repos.sellerModel.countDocuments({}), st: await h.repos.storeModel.countDocuments({}) }).toEqual(before);
  });
});
