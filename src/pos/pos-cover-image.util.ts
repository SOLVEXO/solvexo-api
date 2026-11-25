/**
 * The cover image of a product for the till. The product schema stores its pictures in `images`; `gallery` /
 * `coverImages` are legacy names kept as fallbacks. (The till used to read only the legacy names, which no product has,
 * so every tile showed the placeholder icon.)
 */
export function productCoverImage(p: any): string | null {
  const first = (a: unknown) => (Array.isArray(a) && typeof a[0] === 'string' && a[0] ? (a[0] as string) : null);
  return first(p?.images) ?? first(p?.gallery) ?? first(p?.coverImages) ?? null;
}
