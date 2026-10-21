/* eslint-disable prettier/prettier */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { STOREFRONT_EN } from './storefront-en.source';
import { chunk, flattenStrings, keepsPlaceholders, placeholdersOf, unflattenStrings } from './ui-locales.util';

describe('ui-locales.util', () => {
  it('flattens and rebuilds nested bundles without losing a key', () => {
    const flat = flattenStrings(STOREFRONT_EN);
    expect(Object.keys(flat).length).toBeGreaterThan(700);
    expect(flattenStrings(unflattenStrings(flat))).toEqual(flat);
  });

  it('requires the same {{placeholders}} in a translation', () => {
    expect(placeholdersOf('Hi {{ name }}, {{count}} items')).toEqual(['{{count}}', '{{name}}']);
    expect(keepsPlaceholders('Hi {{name}}', 'Hallo {{name}}')).toBe(true);
    expect(keepsPlaceholders('Hi {{name}}', 'Hallo')).toBe(false);
    expect(keepsPlaceholders('Hi {{name}}', 'Hallo {{nom}}')).toBe(false);
  });

  it('splits into batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  // The API keeps a copy of the English storefront text to translate from; it must follow the web app's file.
  const webFile = join(__dirname, '../../../solvexo-web/src/i18n/locales/storefront.en.json');
  (existsSync(webFile) ? it : it.skip)('has the same text as the web app English bundle', () => {
    expect(flattenStrings(STOREFRONT_EN)).toEqual(flattenStrings(JSON.parse(readFileSync(webFile, 'utf8'))));
  });
});
