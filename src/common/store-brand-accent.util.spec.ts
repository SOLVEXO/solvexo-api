import { resolveStoreAccent } from './store-brand-accent.util';

const themes = (primaryColor: unknown, fail = false) => ({
  storeThemeModel: { findOne: () => ({ select: () => ({ lean: async () => { if (fail) throw new Error('down'); return primaryColor === undefined ? null : { theme: { primaryColor } }; } }) }) },
});

describe('resolveStoreAccent (the store\'s brand colour for emails, the invoice PDF and the pay page)', () => {
  it('the colour the seller picked for customer notifications wins, normalised', async () => {
    expect(await resolveStoreAccent(themes('#111111'), 's1', '#6B2D44')).toBe('#6b2d44');
    expect(await resolveStoreAccent(themes('#111111'), 's1', '6B2D44')).toBe('#6b2d44');
  });

  it('with none picked it follows the main colour of the live theme', async () => {
    expect(await resolveStoreAccent(themes('#0156FF'), 's1', null)).toBe('#0156ff');
    expect(await resolveStoreAccent(themes('#0156FF'), 's1', '')).toBe('#0156ff');
    expect(await resolveStoreAccent(themes('#0156FF'), 's1', 'not-a-colour')).toBe('#0156ff');
  });

  it('with neither (or a bad value, a missing model, a failing lookup) it is null, so the caller uses its own default', async () => {
    expect(await resolveStoreAccent(themes(undefined), 's1')).toBeNull();
    expect(await resolveStoreAccent(themes('red'), 's1')).toBeNull();
    expect(await resolveStoreAccent({}, 's1')).toBeNull();
    expect(await resolveStoreAccent(themes('#123456', true), 's1')).toBeNull();
  });
});
