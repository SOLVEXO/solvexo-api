/* eslint-disable prettier/prettier */
import { Schema } from 'mongoose';

/**
 * Makes a collection append-only at the application layer: there is NO update or delete path through the Mongoose model.
 * Any `updateOne/updateMany/findOneAndUpdate/replaceOne/deleteOne/deleteMany/findOneAndDelete` and any `save()` of an
 * already-persisted document throws. Raw driver access (`model.collection.*`) is deliberately NOT blocked here — that
 * is closed at the database with a role that has only `insert`/`find` on these collections (see
 * docs/pos-blueprint/G1A_SUMMARY.md, "Immutability").
 *
 * `allowSetFields` lets a collection permit `$set` on a short list of fields (e.g. a payment's `status` moving from
 * `recorded_unverified` to `confirmed` once a terminal integration confirms it) — everything else stays frozen, and
 * deletes are never allowed.
 */
export function makeAppendOnly(schema: Schema, opts: { allowSetFields?: string[] } = {}): void {
  const allowed = new Set(opts.allowSetFields ?? []);
  const deny = (what: string) => {
    throw new Error(`${what} is not allowed: this collection is append-only (audit-grade record)`);
  };

  schema.pre('save', function () {
    if (!this.isNew) deny('Updating a persisted record');
  });

  schema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'] as any, function () {
    deny('Deleting a record');
  });
  schema.pre('deleteOne', { document: true, query: false }, function () {
    deny('Deleting a record');
  });

  schema.pre(['replaceOne', 'findOneAndReplace'] as any, function () {
    deny('Replacing a record');
  });

  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'] as any, function (this: any) {
    const update = this.getUpdate?.() ?? {};
    // Mongoose adds `$setOnInsert: { createdAt }` to every update when timestamps are on; with no upsert it can never apply.
    const ops = Object.keys(update).filter((k) => !(k === '$setOnInsert' && Object.keys(update.$setOnInsert ?? {}).every((f) => f === 'createdAt')));
    const onlyAllowedSet =
      allowed.size > 0 &&
      ops.length > 0 &&
      ops.every((k) => k === '$set') &&
      Object.keys(update.$set ?? {}).every((f) => allowed.has(f));
    if (!onlyAllowedSet) deny(`Updating a record (update keys: ${JSON.stringify(update)})`);
  });
}
