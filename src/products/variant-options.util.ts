export interface VariantOptionInput {
  name: string;
  value: string;
}

const MAX_OPTIONS_PER_VARIANT = 3;
const MAX_OPTION_LENGTH = 40;

/** Canonical key for a variant's full attribute/value combination — two variants
 * with the same key (order-independent, case/whitespace-insensitive) are duplicates. */
export function optionsKey(options: VariantOptionInput[]): string {
  return (options ?? [])
    .map((o) => `${o.name.trim().toLowerCase()}:${o.value.trim().toLowerCase()}`)
    .sort()
    .join('|');
}

/** Canonical key for the *set* of attribute names only (ignoring values) — every
 * active variant on a product must share this, so the buyer selector can render
 * consistent chip rows (e.g. can't mix a {Color} variant with a {Color,Size} one). */
export function optionNameSet(options: VariantOptionInput[]): string {
  return (options ?? [])
    .map((o) => o.name.trim().toLowerCase())
    .sort()
    .join('|');
}

/** " (Red, M)" style suffix for building a display name from a variant's options — empty string when there are none. */
export function formatOptionsSuffix(options: VariantOptionInput[] | undefined | null): string {
  if (!options || options.length === 0) return '';
  return ` (${options.map((o) => o.value).join(', ')})`;
}

export function validateOptions(options: VariantOptionInput[] | undefined | null): void {
  if (!options) return;
  if (!Array.isArray(options)) {
    throw new Error('options must be an array');
  }
  if (options.length > MAX_OPTIONS_PER_VARIANT) {
    throw new Error(`A variant may have at most ${MAX_OPTIONS_PER_VARIANT} attributes`);
  }
  for (const o of options) {
    if (!o || typeof o.name !== 'string' || typeof o.value !== 'string') {
      throw new Error('Each option requires a name and value');
    }
    if (!o.name.trim() || !o.value.trim()) {
      throw new Error('Option name and value cannot be empty');
    }
    if (o.name.trim().length > MAX_OPTION_LENGTH || o.value.trim().length > MAX_OPTION_LENGTH) {
      throw new Error(`Option name/value must be at most ${MAX_OPTION_LENGTH} characters`);
    }
  }
}
