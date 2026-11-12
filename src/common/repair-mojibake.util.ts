// Windows-1252 bytes 0x80-0x9F that map to characters outside U+0080-U+009F.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * Text that was UTF-8 but got read as Windows-1252/Latin-1 ("Ø¹Ø«Ù…Ø§Ù†" instead of Arabic/Urdu) is turned back.
 * Only changes a string when EVERY character maps back to a byte and the bytes are valid UTF-8, so normal text is never touched.
 */
export function repairMojibake(input: string): string {
  if (!/[Â-ô]/.test(input)) return input;
  const bytes: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x100) bytes.push(cp);
    else if (CP1252[cp] !== undefined) bytes.push(CP1252[cp]);
    else return input;
  }
  try {
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return fixed.length < input.length ? fixed : input;
  } catch {
    return input;
  }
}

/** Repairs every string inside plain objects/arrays in place (Buffers, Dates and other class instances are left alone). */
export function repairMojibakeDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return repairMojibake(value) as unknown as T;
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = repairMojibakeDeep(value[i], depth + 1);
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const rec = value as Record<string, unknown>;
  for (const k of Object.keys(rec)) rec[k] = repairMojibakeDeep(rec[k], depth + 1);
  return value;
}
