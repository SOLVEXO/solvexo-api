import { ThemeSettingsMapConstraint } from './update-theme.dto';

describe('UpdateThemeDto.themeSettings (theme-declared settings bag)', () => {
  const ok = (v: unknown) => new ThemeSettingsMapConstraint().validate(v);

  it('accepts simple keys with text, number and boolean values', () => {
    expect(ok({ showBadge: true, label: 'New', columns: 3 })).toEqual(true);
    expect(ok({})).toEqual(true);
  });

  it('rejects non-objects, odd key names and unsupported values', () => {
    for (const bad of [null, 'x', 5, [], { '$gt': 1 }, { 'a.b': 1 }, { '1st': 1 }, { a: { nested: 1 } }, { a: [1] }, { a: Number.NaN }, { a: 'x'.repeat(501) }]) {
      expect(ok(bad)).toEqual(false);
    }
  });

  it('caps the number of keys at 60', () => {
    const sixty = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 1]));
    expect(ok(sixty)).toEqual(true);
    expect(ok({ ...sixty, extra: 1 })).toEqual(false);
  });
});
