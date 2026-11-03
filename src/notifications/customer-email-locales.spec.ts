import { EMAIL_UI_STRINGS, emailUiStrings } from './customer-email-locales';
describe('email ui strings', () => {
  it('every language has every key and keeps {brand}', () => {
    const keys = Object.keys(EMAIL_UI_STRINGS.en).sort();
    for (const [lang, s] of Object.entries(EMAIL_UI_STRINGS)) {
      expect(Object.keys(s).sort()).toEqual(keys);
      expect((s as any).receivingBecause.includes('{brand}')).toBe(true);
      for (const v of Object.values(s)) expect(String(v).trim().length > 0).toBe(true);
      expect(lang.length).toBe(2);
    }
    expect(Object.keys(EMAIL_UI_STRINGS).length).toBe(22);
    expect(emailUiStrings('fr-CA').invShipping).toBe('Livraison');
    expect(emailUiStrings('xx').invShipping).toBe('Shipping');
  });
});
