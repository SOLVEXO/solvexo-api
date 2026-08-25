/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import type { Model } from 'mongoose';

/**
 * A single Mongo aggregation-pipeline expression: a `$field.path` reference
 * string, or a nested plain object whose own values are themselves
 * expressions (e.g. `{ theme: '$theme', header: '$header' }` set as one
 * field's value) — nesting is what lets a multi-field draft like
 * `StoreTheme.draft` be written in one shot instead of one dot-path per
 * field. Deliberately not typed any narrower — this is exactly the shape
 * Mongo's own `$set` stage accepts.
 */
export type FieldExpressionValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: FieldExpressionValue };

/**
 * Maps a field path to the expression that reads its counterpart — e.g.
 * `{ sections: '$draft.sections' }` for a publish, or
 * `{ draft: { theme: '$theme', header: '$header' } }` for a revert. Same
 * shape either direction; which one is "source" vs. "target" is just which
 * method you call and which side of the map you write.
 */
export type FieldExpressionMap = Record<string, FieldExpressionValue>;

/**
 * The one place the atomic draft↔live copy technique lives, generalized from
 * what `StoreThemeService.publishTheme`/`revertDraftToPublished` originally
 * hand-rolled. A single `findOneAndUpdate` with an aggregation-pipeline
 * `$set` (not a read-modify-write) is what makes this safe — the source
 * fields are read and written in the same atomic operation, so there's no
 * window where a concurrent write could interleave and produce a
 * half-copied document.
 *
 * Every content type with a draft/publish split (StoreTheme today; StorePage
 * as of this pass; any future Template type) should route its publish/revert
 * through this service instead of writing its own copy of this pipeline.
 */
@Injectable()
export class ContentVersioningService {
  /** Copies draft field(s) into their live counterparts. `extraSet` is for fields that aren't a draft→live copy but should land in the same atomic write (e.g. `lastPublishedAt: '$$NOW'`, `status: 'published'`). */
  async publishDraft<T = any>(
    model: Model<T>,
    filter: Record<string, unknown>,
    fieldMap: FieldExpressionMap,
    extraSet: Record<string, unknown> = {},
  ): Promise<T | null> {
    return model.findOneAndUpdate(
      filter,
      [{ $set: { ...fieldMap, ...extraSet } }],
      // Mongoose 9 requires this explicit opt-in before it will accept an
      // array as an aggregation-pipeline update (previously auto-detected) —
      // without it every call here throws `MongooseError: Cannot pass an
      // array to query updates unless the \`updatePipeline\` option is set.`,
      // silently breaking every draft→publish action (found via real runtime
      // testing, not just type-checking — createStore's theme backfill was
      // the first live call site to actually exercise this after a Mongoose
      // version bump).
      { new: true, updatePipeline: true },
    );
  }

  /** Mirror-direction copy — live field(s) back into their draft counterparts (the "discard unsaved changes" action). */
  async revertDraft<T = any>(
    model: Model<T>,
    filter: Record<string, unknown>,
    fieldMap: FieldExpressionMap,
  ): Promise<T | null> {
    return model.findOneAndUpdate(filter, [{ $set: fieldMap }], { new: true, updatePipeline: true });
  }

  /**
   * Idempotent lazy backfill for any document predating a draft field —
   * mirrors `StoreThemeService.ensureDefaultTheme`'s exact reasoning: a
   * hydrated Mongoose document always reports schema defaults for a path
   * that was never actually stored, so there's no way to tell "draft was
   * never set" from "draft was set to all-defaults" once it's been read into
   * JS — the filter here MUST be a raw `$exists` check against the stored
   * document, not an app-level check on the hydrated value. No-ops (0
   * matched) for any document that already has a real draft, new or old.
   */
  async backfillDraft(
    model: Model<any>,
    filter: Record<string, unknown>,
    draftPath: string,
    fieldMap: FieldExpressionMap,
  ): Promise<void> {
    await model.updateMany(
      { ...filter, [draftPath]: { $exists: false } },
      [{ $set: { [draftPath]: fieldMap } }],
      { updatePipeline: true },
    );
  }

  // ── Real version history — one shared mechanism for every content type
  // with a draft/publish split (StoreTheme, StorePage, CollectionTemplate).
  // Each type's version subdocument has its own shape (a theme snapshot vs.
  // a sections snapshot aren't the same data), so this can't be a single
  // shared Mongoose subschema — but the snapshot/list/restore *mechanism*
  // is genuinely one implementation, not three independently hand-rolled
  // copies of the same "$push with $slice, then $set draft on restore"
  // logic. Every caller stores its versions under a `versions` array field
  // on its own document (enforced by convention, not by this generic layer).

  /** Appends a new version snapshot, capped at the most recent `cap` (oldest dropped via `$slice`). Call this right after a successful publish, with a snapshot built from the just-published (live) fields. */
  async appendVersion<T = any>(
    model: Model<T>,
    filter: Record<string, unknown>,
    snapshot: Record<string, unknown>,
    cap = 20,
  ): Promise<T | null> {
    return model.findOneAndUpdate(
      filter,
      { $push: { versions: { $each: [snapshot], $slice: -cap } } },
      { new: true },
    );
  }

  /** Newest-first list of a document's version snapshots. */
  async listVersions(model: Model<any>, filter: Record<string, unknown>): Promise<any[]> {
    const doc = await model.findOne(filter).select('versions').lean();
    return ((doc as any)?.versions ?? []).slice().reverse();
  }

  /** Finds one version by its subdocument `_id` within the array — returns null (not a throw) if not found, so callers can 404/400 with their own message. */
  async findVersion(model: Model<any>, filter: Record<string, unknown>, versionId: string): Promise<any | null> {
    const doc = await model.findOne({ ...filter, 'versions._id': versionId }).lean();
    return (doc as any)?.versions?.find((v: any) => v._id.toString() === versionId) ?? null;
  }

  /** Restores a past version into the DRAFT slot only — never straight to
   *  live, for every content type, no exceptions. `draftFieldMap` maps the
   *  version's own fields into `draft.*` (or root `draft` fields) — the
   *  caller decides the shape since it varies per content type. */
  async restoreVersionToDraft<T = any>(
    model: Model<T>,
    filter: Record<string, unknown>,
    draftFieldMap: Record<string, unknown>,
  ): Promise<T | null> {
    return model.findOneAndUpdate(filter, { $set: draftFieldMap }, { new: true });
  }
}
