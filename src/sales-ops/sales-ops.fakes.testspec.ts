/* eslint-disable prettier/prettier */
// Test-only helpers for the Sales Ops specs. The file name ends in "spec.ts" so the build leaves it out
// (tsconfig.build excludes **/*spec.ts), but not ".spec.ts", so Jest doesn't run it as a suite.

/** A tiny in-memory stand-in for a Mongoose model, enough for the queries Sales Ops runs. */
let seq = 0;
const oid = () => (++seq).toString(16).padStart(24, '0');
function matches(doc: any, f: any): boolean {
  return Object.entries(f ?? {}).every(([k, v]: [string, any]) => {
    if (k === '$or') return v.some((x: any) => matches(doc, x));
    const d = doc[k];
    if (v instanceof RegExp) return typeof d === 'string' && v.test(d);
    if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      !Array.isArray(v)
    ) {
      return Object.entries(v).every(([op, x]: [string, any]) => {
        if (op === '$in')
          return (
            x.map(String).includes(String(d)) ||
            (Array.isArray(d) && d.some((e: any) => x.includes(e)))
          );
        if (op === '$ne')
          return x === null
            ? d !== null && d !== undefined
            : String(d) !== String(x);
        if (op === '$lt') return d != null && d < x;
        if (op === '$lte') return d != null && d <= x;
        if (op === '$gte') return d != null && d >= x;
        if (op === '$exists') return (d !== undefined) === x;
        return false;
      });
    }
    if (v === null) return d === null || d === undefined;
    return String(d) === String(v);
  });
}
export function model(rows: any[] = []) {
  // A chainable query: sort() really sorts, the rest pass through; `one` returns the first hit.
  const q = (list: any[], one = false) => {
    let out = list;
    const p: any = {
      then: (ok: any, bad: any) =>
        Promise.resolve(one ? (out[0] ?? null) : out).then(ok, bad),
    };
    for (const m of ['select', 'skip', 'limit', 'lean']) p[m] = () => p;
    p.sort = (s: Record<string, number>) => {
      const [[k, dir]] = Object.entries(s);
      out = [...out].sort((a, b) =>
        a[k] > b[k] ? dir : a[k] < b[k] ? -dir : 0,
      );
      return p;
    };
    return p;
  };
  return {
    rows,
    find: jest.fn((f?: any) =>
      q(rows.filter((r) => matches(r, f)).map((r) => ({ ...r }))),
    ),
    findOne: jest.fn((f?: any) =>
      q(
        rows.filter((r) => matches(r, f)),
        true,
      ),
    ),
    findById: jest.fn((id: string) =>
      q(
        rows.filter((r) => String(r._id) === String(id)),
        true,
      ),
    ),
    countDocuments: jest.fn(
      async (f?: any) => rows.filter((r) => matches(r, f)).length,
    ),
    create: jest.fn(async (doc: any) => {
      const r = { _id: oid(), createdAt: new Date(), isDelete: false, ...doc };
      rows.push(r);
      return r;
    }),
    insertMany: jest.fn(async (docs: any[]) =>
      docs.map((d) => {
        const r = { _id: oid(), createdAt: new Date(), isDelete: false, ...d };
        rows.push(r);
        return { ...r, toObject: () => ({ ...r }) };
      }),
    ),
    updateOne: jest.fn(async (f: any, u: any) => {
      const r = rows.find((x) => matches(x, f));
      if (r) Object.assign(r, u.$set);
      return { matchedCount: r ? 1 : 0 };
    }),
    deleteOne: jest.fn(async (f: any) => {
      const i = rows.findIndex((x) => matches(x, f));
      if (i >= 0) rows.splice(i, 1);
    }),
  };
}
