/* eslint-disable prettier/prettier */

/** Languages whose storefront bundle ships with the web app (solvexo-web/src/i18n/locales); every other one is generated. */
export const STATIC_UI_LOCALES: readonly string[] = [
  'en', 'ur', 'ar', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'tr', 'hi', 'fa', 'id', 'ru', 'zh', 'ja', 'ko', 'ms', 'pl', 'sv', 'th', 'vi',
];

export type FlatStrings = Record<string, string>;

export function flattenStrings(obj: Record<string, any>, prefix = '', out: FlatStrings = {}): FlatStrings {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenStrings(v, key, out);
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/** `{ 'a.b': 'x' }` -> `{ a: { b: 'x' } }` (keys that are both a leaf and a parent keep the leaf under `_`). */
export function unflattenStrings(flat: FlatStrings): Record<string, any> {
  const root: Record<string, any> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
  return root;
}

const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}/g;

/** The `{{name}}` placeholders of a string, sorted: a translation must contain exactly the same ones. */
export function placeholdersOf(text: string): string[] {
  return (text.match(PLACEHOLDER) ?? []).map((p) => p.replace(/\s+/g, '')).sort();
}

export function keepsPlaceholders(source: string, translated: string): boolean {
  return JSON.stringify(placeholdersOf(source)) === JSON.stringify(placeholdersOf(translated));
}

/** Splits `items` into batches of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
