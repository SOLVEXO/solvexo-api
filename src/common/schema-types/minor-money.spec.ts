import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import './minor-money';
import { MAX_MINOR } from '../money-minor.util';

jest.setTimeout(120_000);

/** MinorMoney against a REAL MongoDB: what is stored, what is read, what is serialised, what is rejected. */
let conn: mongoose.Connection;
let own: MongoMemoryReplSet | null = null;
let Model: mongoose.Model<any>;

beforeAll(async () => {
  const uri = process.env.TEST_MONGO_URI ?? (own = await MongoMemoryReplSet.create({ replSet: { count: 1 } })).getUri();
  conn = await mongoose.createConnection(uri, { dbName: `minor_money_${process.pid}_${Date.now()}` }).asPromise();
  const S = new mongoose.Schema({ label: String, amountMinor: { type: 'MinorMoney' }, nested: [{ _id: false, vMinor: { type: 'MinorMoney' } }] }, { versionKey: false });
  S.set('toJSON', { getters: true, virtuals: false });
  Model = conn.model('MinorMoneyProbe', S);
});
afterAll(async () => {
  await conn?.dropDatabase();
  await conn?.close();
  await own?.stop();
});
beforeEach(async () => {
  await Model.collection.deleteMany({});
});

const bsonType = async (id: any, path = 'amountMinor') => ((await Model.collection.aggregate([{ $match: { _id: id } }, { $project: { t: { $type: `$${path}` } } }]).toArray())[0] as any).t;

describe('MinorMoney', () => {
  it.each([0, 1999, 2147483647, 2147483648, 21474836480, MAX_MINOR, -250, -MAX_MINOR])('stores %p as a BSON long (never int32 or double) and reads it back exactly', async (v) => {
    const d: any = await Model.create({ amountMinor: v });
    expect(await bsonType(d._id)).toBe('long');
    const lean: any = await Model.findById(d._id).lean();
    expect(typeof lean.amountMinor).toBe('number');
    expect(lean.amountMinor).toBe(v);
    const doc: any = await Model.findById(d._id);
    expect(doc.amountMinor).toBe(v);
    expect(JSON.parse(JSON.stringify(doc)).amountMinor).toBe(v); // a plain JSON number
    expect(JSON.parse(JSON.stringify(d)).amountMinor).toBe(v); // …also straight after create()
  });

  it('is stored as long inside arrays and in $inc / $set updates (Mongoose update casting)', async () => {
    const d: any = await Model.create({ amountMinor: 100, nested: [{ vMinor: 5 }, { vMinor: 7 }] });
    const nestedType = ((await Model.collection.aggregate([{ $match: { _id: d._id } }, { $project: { t: { $type: { $arrayElemAt: ['$nested.vMinor', 0] } } } }]).toArray())[0] as any).t;
    expect(nestedType).toBe('long');
    await Model.updateOne({ _id: d._id }, { $inc: { amountMinor: 250 } });
    expect(await bsonType(d._id)).toBe('long');
    expect(((await Model.findById(d._id).lean()) as any).amountMinor).toBe(350);
    await Model.updateOne({ _id: d._id }, { $inc: { amountMinor: -400 } });
    expect(((await Model.findById(d._id).lean()) as any).amountMinor).toBe(-50);
    await Model.updateOne({ _id: d._id }, { $set: { amountMinor: 2147483648 } });
    expect(await bsonType(d._id)).toBe('long');
    // queries cast too
    expect(await Model.countDocuments({ amountMinor: 2147483648 })).toBe(1);
    expect(await Model.countDocuments({ amountMinor: { $in: [1, 2147483648] } })).toBe(1);
  });

  it('REJECTS fractions, strings, NaN, ±Infinity, values above 2^53-1 and objects', async () => {
    for (const bad of [19.99, 0.1, '12.5', 'abc', NaN, Infinity, -Infinity, MAX_MINOR + 1, -(MAX_MINOR + 1), 2 ** 60, {}, [], true]) {
      const doc = new Model({ amountMinor: bad });
      const err = doc.validateSync();
      expect({ bad: String(bad), rejected: !!err }).toEqual({ bad: String(bad), rejected: true });
      await expect(Model.create({ amountMinor: bad })).rejects.toBeTruthy();
    }
    expect(await Model.countDocuments({})).toBe(0);
  });

  it('accepts absent (a legacy row has no minor yet); a numeric string of an integer is NOT silently coerced', async () => {
    const d: any = await Model.create({ label: 'legacy' });
    expect(((await Model.findById(d._id).lean()) as any).amountMinor).toBeUndefined();
    await expect(Model.create({ amountMinor: '12' })).rejects.toBeTruthy();
  });
});
