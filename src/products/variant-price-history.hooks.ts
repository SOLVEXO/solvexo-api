/* eslint-disable prettier/prettier */
import { Schema } from 'mongoose';

const MODEL = 'VariantPriceHistory';

/**
 * Records the OLD price whenever a ProductVariant's `price` changes through Mongoose (save / findOneAndUpdate /
 * updateOne / updateMany) — so every existing code path that edits prices is covered without touching it. Direct
 * driver calls (`collection.…`, `bulkWrite`) bypass Mongoose middleware; none of the current ones change `price`.
 * Purely additive and failure-proof: history is best-effort and can never block or fail a price change.
 */
export function applyPriceHistoryHooks(schema: Schema): void {
  const nextPrice = (update: any): number | undefined => {
    if (!update) return undefined;
    const v = update.$set && update.$set.price !== undefined ? update.$set.price : (update.price !== undefined ? update.price : undefined);
    return v === undefined || v === null || Number.isNaN(Number(v)) ? undefined : Number(v);
  };
  const record = async (db: any, rows: Array<{ variantId: string; price: number }>) => {
    const model = db?.models?.[MODEL];
    if (!model || rows.length === 0) return;
    const now = new Date();
    await model.insertMany(rows.map((r) => ({ ...r, supersededAt: now })), { ordered: false });
  };

  const queryOps = ['findOneAndUpdate', 'updateOne', 'updateMany'] as const;
  for (const op of queryOps) {
    schema.pre(op, { document: false, query: true }, async function (this: any) {
      try {
        const next = nextPrice(this.getUpdate());
        if (next === undefined) return;
        const before = await this.model.find(this.getFilter()).select('_id price').limit(5000).lean();
        this._priceHistory = { next, before };
      } catch { /* never block the update */ }
    });
    schema.post(op, { document: false, query: true }, async function (this: any) {
      try {
        const h = this._priceHistory;
        if (!h) return;
        await record(this.model.db, h.before.filter((d: any) => Number(d.price) !== h.next).map((d: any) => ({ variantId: String(d._id), price: Number(d.price) })));
      } catch { /* best effort */ }
    });
  }

  schema.pre('save', async function (this: any) {
    try {
      if (this.isNew || !this.isModified('price')) return;
      const prev = await (this.constructor as any).findById(this._id).select('price').lean();
      this.$locals.priceBefore = prev ? Number(prev.price) : undefined;
    } catch { /* never block the save */ }
  });
  schema.post('save', async function (this: any) {
    try {
      const before = this.$locals?.priceBefore;
      if (before === undefined || before === Number(this.price)) return;
      await record((this.constructor as any).db, [{ variantId: String(this._id), price: before }]);
    } catch { /* best effort */ }
  });
}
