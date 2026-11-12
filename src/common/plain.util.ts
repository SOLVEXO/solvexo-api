/**
 * `{ ...doc }` of a hydrated Mongoose document / sub-document copies none of its schema fields (they are prototype getters),
 * so the copy silently loses variantId, bundleComponents, status ... Always go through this before spreading a value that may
 * be hydrated. Plain / lean objects pass through unchanged.
 */
export function plain<T>(x: T): T {
  return x && typeof (x as any).toObject === 'function' ? (x as any).toObject() : x;
}
