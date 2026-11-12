/* eslint-disable prettier/prettier */
import { Schema } from 'mongoose';

/**
 * Makes a collection append-only at the application layer: there is NO update or delete path through the Mongoose model.
 * Any `updateOne/updateMany/findOneAndUpdate/replaceOne/deleteOne/deleteMany/findOneAndDelete` and any `save()` of an
 * already-persisted document throws. Raw driver access (`model.collection.*`) is deliberately NOT blocked here — that
 * is closed at the database with a role that has only `insert`/`find` on these collections (see
 * docs/pos-blueprint/G1A_SUMMARY.md, "Immutability").
 *
 * There is no "allowed fields" escape hatch (the G1a `allowSetFields` hook was removed in G2.1): state that changes over time is
 * modelled as appended status events (see `payment_events`), never as an update.
 */
export function makeAppendOnly(schema: Schema): void {
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
    deny(`Updating a record (update keys: ${JSON.stringify(update)})`);
  });
}
