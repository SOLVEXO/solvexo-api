import mongoose, { SchemaType } from 'mongoose';
import { Long } from 'mongodb';
import { MAX_MINOR } from '../money-minor.util';

/**
 * The ONE way to declare an integer money field in the minor unit of a currency (cents / paisa / fils / yen) — POS and every new
 * module (ENGINEERING_RULES.md §2). Why not `Number`: above 2^31 MongoDB silently stores a DOUBLE. Why not `BigInt`: it stores a
 * long but cannot be JSON-serialised.
 *
 *  - WRITES a BSON `long` (int64), always.
 *  - READS a plain JS integer (`.lean()` via the driver's promoteLongs, documents via the getter) and serialises to JSON as a
 *    plain number (schemas that use it set `toJSON: { getters: true }`).
 *  - REJECTS (cast error → validation error) anything that is not a safe integer: fractions, strings, NaN, ±Infinity,
 *    and |value| > 2^53 − 1 (the largest integer a JS number and a Dart int hold exactly).
 *
 * Declare with `@Prop({ type: 'MinorMoney' })` after importing this module once (it registers the type).
 */
export class MinorMoney extends SchemaType {
  constructor(path: string, options?: any) {
    super(path, options, 'MinorMoney');
    this.get((v: any) => (v instanceof Long ? v.toNumber() : v));
  }

  static toSafeInteger(val: any): number {
    const n = val instanceof Long ? val.toNumber() : typeof val === 'bigint' ? Number(val) : val;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isSafeInteger(n) || Math.abs(n) > MAX_MINOR) {
      throw new Error(`must be an integer number of minor units, |value| <= 2^53-1 (got ${String(val)})`);
    }
    return n;
  }

  cast(val: any): any {
    if (val === null || val === undefined) return val;
    try {
      return Long.fromNumber(MinorMoney.toSafeInteger(val));
    } catch (e: any) {
      throw new mongoose.Error.CastError('MinorMoney', val, this.path, e);
    }
  }

  castForQuery($conditional: string | null, val?: any): any {
    if (arguments.length === 1) val = $conditional; // castForQuery(val)
    if (Array.isArray(val)) return val.map((v) => this.cast(v));
    return this.cast(val);
  }
}

// register once: `{ type: 'MinorMoney' }` resolves through Schema.Types
(mongoose.Schema.Types as any).MinorMoney = MinorMoney;
export default MinorMoney;
