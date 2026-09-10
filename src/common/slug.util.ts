import { Model } from 'mongoose';

/** Lowercase/hyphenate a name into a URL-safe base slug — same convention already used by Store's own slug generator. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Generate a slug for `name` that's unique within `model`'s `slug` field,
 * appending a numeric suffix on collision. `excludeId` lets a rename check
 * uniqueness against every other document without colliding with itself.
 *
 * `scope` (e.g. `{ storeId }`) narrows the collision check to within that
 * scope only — required for any per-store resource (Product, Category):
 * without it, two unrelated sellers both naming something "Electronics"
 * would collide with EACH OTHER globally, and a soft-deleted document's slug
 * would stay permanently unusable platform-wide forever (found as a real bug
 * during the Catalog audit — every other per-store slug in this codebase,
 * e.g. Collection/Blog/StorePage, already scopes by storeId; Product/Category
 * were the two stragglers still calling this without it). Omit `scope`
 * entirely for a genuinely platform-wide resource (Campaign is the one real
 * caller today) — that keeps its existing global-uniqueness behavior.
 * `isDelete: true` documents are always excluded from the collision check
 * regardless of scope, so a deleted item's name/slug is never squatted.
 */
export async function generateUniqueSlug(
  model: Model<any>,
  name: string,
  opts: { excludeId?: string; scope?: Record<string, any> } = {},
): Promise<string> {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let count = 1;

  while (
    await model.findOne({
      slug,
      isDelete: { $ne: true },
      ...(opts.scope ?? {}),
      ...(opts.excludeId ? { _id: { $ne: opts.excludeId } } : {}),
    })
  ) {
    slug = `${baseSlug}-${count}`;
    count++;
  }

  return slug;
}
