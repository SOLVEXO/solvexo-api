/**
 * The global ValidationPipe does not whitelist (main.ts), so a request body can
 * carry keys that are not in its DTO. Handlers that write a body into Mongo must
 * therefore pick the fields they allow — never spread the body.
 * Only keys that were actually sent are returned (undefined stays untouched).
 */
export function pickFields<T extends object, K extends string>(
  body: T | null | undefined,
  allowed: readonly K[],
): Partial<Record<K, any>> {
  const out: Partial<Record<K, any>> = {};
  if (!body) return out;
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, k) && (body as any)[k] !== undefined) out[k] = (body as any)[k];
  }
  return out;
}
