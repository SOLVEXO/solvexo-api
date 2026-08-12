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
 */
export async function generateUniqueSlug(
  model: Model<any>,
  name: string,
  opts: { excludeId?: string } = {},
): Promise<string> {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  let count = 1;

  while (
    await model.findOne({
      slug,
      ...(opts.excludeId ? { _id: { $ne: opts.excludeId } } : {}),
    })
  ) {
    slug = `${baseSlug}-${count}`;
    count++;
  }

  return slug;
}
