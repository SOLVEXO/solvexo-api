/**
 * `ActivityLog.metadata` shape for a value change — rendered by the admin/
 * seller Activity Log's detail modal as "Field: before → after" instead of
 * a plain description string. Only fields that actually changed are
 * included (a field passed in `fields` whose before === after is skipped),
 * so a diff of a handful of watched fields never reports false noise.
 */
export interface ActivityDiffMetadata {
  changes: { field: string; before: unknown; after: unknown }[];
}

export function buildDiffMetadata(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): ActivityDiffMetadata | null {
  const changes = fields
    .filter((f) => before[f] !== after[f])
    .map((f) => ({ field: f, before: before[f] ?? null, after: after[f] ?? null }));
  return changes.length > 0 ? { changes } : null;
}
