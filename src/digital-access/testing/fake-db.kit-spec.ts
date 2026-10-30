/* Test kit (not a spec, not built): in-memory stand-ins for the Mongoose models and Redis used by the digital services. */

const get = (obj: any, path: string): any => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (a: any, b: any) => (a instanceof Date || b instanceof Date ? new Date(a as any).getTime() === new Date(b as any).getTime() : String(a ?? null) === String(b ?? null));

/** Mongo-ish matcher: equality, $in/$ne/$gt/$gte/$lt/$lte/$exists, $or, dotted paths, array "contains". */
export function matches(doc: any, filter: any): boolean {
  return Object.entries(filter ?? {}).every(([k, cond]: [string, any]) => {
    if (k === '$or') return cond.some((f: any) => matches(doc, f));
    let val = get(doc, k);
    if (val === undefined && k.includes('.')) {
      // dotted path through an array of sub documents: sellerOrders.items.productId
      const [head, ...rest] = k.split('.');
      const arr = doc?.[head];
      const existsCond = cond && typeof cond === 'object' && '$exists' in cond;
      if (Array.isArray(arr) && !/^d+$/.test(rest[0]) && !existsCond) {
        const negative = cond && typeof cond === 'object' && ('$ne' in cond);
        return negative ? arr.every((x: any) => matches(x, { [rest.join('.')]: cond })) : arr.some((x: any) => matches(x, { [rest.join('.')]: cond }));
      }
    }
    const test = (v: any) => {
      if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
        if ('$in' in cond && !cond.$in.some((c: any) => same(c, v))) return false;
        if ('$ne' in cond && same(cond.$ne, v)) return false;
        if ('$gt' in cond && !(v != null && v > cond.$gt)) return false;
        if ('$gte' in cond && !(v != null && v >= cond.$gte)) return false;
        if ('$lt' in cond && !(v != null && v < cond.$lt)) return false;
        if ('$lte' in cond && !(v != null && v <= cond.$lte)) return false;
        if ('$exists' in cond && (v !== undefined) !== cond.$exists) return false;
        return true;
      }
      return same(cond, v);
    };
    if (Array.isArray(val) && !(cond && typeof cond === 'object' && '$exists' in cond)) {
      // Mongo: $ne on an array field matches only when NO element equals the value
      if (cond && typeof cond === 'object' && '$ne' in cond) return val.every(test);
      return val.some(test) || test(val);
    }
    return test(val);
  });
}

let seq = 0;
export class FakeModel {
  rows: any[] = [];
  constructor(private defaults: Record<string, any> = {}) {}

  private wrap(r: any) {
    if (!r || r.save) return r;
    Object.defineProperty(r, 'save', { value: async () => r, enumerable: false });
    Object.defineProperty(r, 'toObject', { value: () => ({ ...r }), enumerable: false });
    return r;
  }
  private chain(result: any) {
    let cur = result;
    const p: any = { then: (a: any, b: any) => Promise.resolve(cur).then(a, b), catch: (b: any) => Promise.resolve(cur).catch(b) };
    p.skip = (n: number) => { if (Array.isArray(cur)) cur = cur.slice(n); return p; };
    p.limit = (n: number) => { if (Array.isArray(cur)) cur = cur.slice(0, n); return p; };
    for (const m of ['sort', 'select', 'lean']) p[m] = () => p;
    return p;
  }

  async create(d: any) {
    const r = this.wrap({ _id: `id${++seq}`, createdAt: new Date(), ...JSON.parse(JSON.stringify(this.defaults)), ...d });
    // the real models have unique indexes; a model may declare which fields are unique together
    if ((this as any).unique && this.rows.some((x) => (this as any).unique.every((f: string) => same(x[f], r[f])))) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    this.rows.push(r);
    return r;
  }
  find(f: any = {}) { return this.chain(this.rows.filter((r) => matches(r, f)).map((r) => this.wrap(r))); }
  findOne(f: any = {}) { return this.chain(this.wrap(this.rows.find((r) => matches(r, f)) ?? null)); }
  findById(id: string) { return this.findOne({ _id: id }); }
  async exists(f: any) { return this.rows.find((r) => matches(r, f)) ? { _id: 'x' } : null; }
  async countDocuments(f: any = {}) { return this.rows.filter((r) => matches(r, f)).length; }

  private apply(r: any, u: any) {
    for (const [k, v] of Object.entries(u.$set ?? {})) set(r, k, v);
    for (const [k, v] of Object.entries(u.$inc ?? {})) set(r, k, (get(r, k) ?? 0) + (v as number));
    for (const [k, v] of Object.entries(u.$push ?? {})) { const a = get(r, k) ?? []; a.push(v); set(r, k, a); }
    for (const [k, v] of Object.entries(u.$addToSet ?? {})) { const a = get(r, k) ?? []; if (!a.includes(v)) a.push(v); set(r, k, a); }
    for (const [k, v] of Object.entries(u.$pull ?? {})) { const a = (get(r, k) ?? []).filter((x: any) => !matches(x, v as any)); set(r, k, a); }
  }
  async updateOne(f: any, u: any, opts: any = {}) {
    const r = this.rows.find((x) => matches(x, f));
    if (!r) {
      if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const base: any = {};
      for (const [k, v] of Object.entries(f)) if (!k.startsWith('$') && (typeof v !== 'object' || v instanceof Date)) base[k] = v;
      const n = await this.create({ ...base, ...(u.$setOnInsert ?? {}) });
      this.apply(n, u);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    this.apply(r, u);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }
  async updateMany(f: any, u: any) {
    const hit = this.rows.filter((r) => matches(r, f));
    hit.forEach((r) => this.apply(r, u));
    return { matchedCount: hit.length, modifiedCount: hit.length };
  }
  async findOneAndUpdate(f: any, u: any, opts: any = {}) {
    await this.updateOne(f, u, opts);
    return this.rows.find((r) => matches(r, f)) ?? null;
  }
}
function set(obj: any, path: string, value: any) {
  const parts = path.split('.');
  let o = obj;
  parts.slice(0, -1).forEach((p) => { o = o[p] = o[p] ?? {}; });
  o[parts[parts.length - 1]] = value;
}

/** Redis stand-in: set/get/getDel/del/incrWithTtl/decr (TTL not simulated; tests clear keys to "expire" them). */
export class FakeRedis {
  kv = new Map<string, string>();
  counters = new Map<string, number>();
  async set(k: string, v: string) { this.kv.set(k, v); }
  async get(k: string) { return this.kv.get(k) ?? null; }
  async getDel(k: string) { const v = this.kv.get(k) ?? null; this.kv.delete(k); return v; }
  async del(k: string) { this.kv.delete(k); }
  async incrWithTtl(k: string) { const n = (this.counters.get(k) ?? 0) + 1; this.counters.set(k, n); return n; }
  async decr(k: string) { const n = (this.counters.get(k) ?? 1) - 1; if (n <= 0) this.counters.delete(k); else this.counters.set(k, n); }
}

/** The repositories object the services read through DatabaseService. */
export function makeDb() {
  const repositories = {
    orderModel: new FakeModel(), productModel: new FakeModel(), storeModel: new FakeModel(), userModel: new FakeModel(),
  };
  return { db: { repositories } as any, ...repositories };
}

export function paidOrder(over: any = {}) {
  return {
    _id: 'o1', userId: 'c1', isPaid: true, isDelete: false,
    sellerOrders: [{ storeId: 's1', items: [{ _id: 'i1', type: 'digital', productId: 'p1', status: 'pending', totalPrice: 10 }] }],
    ...over,
  };
}

export const digitalProduct = (over: any = {}) => ({
  _id: 'p1', storeId: 's1', name: 'Brand Kit', type: 'digital', isDelete: false,
  digital: { downloadLimit: '3', linkExpiryDays: null, files: [{ url: 'private/digital-products/a.pdf', name: 'a.pdf', size: 10, mimeType: 'application/pdf' }] },
  ...over,
});
