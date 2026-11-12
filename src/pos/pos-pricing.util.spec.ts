/* eslint-disable prettier/prettier */
import { bookActive, ModifierGroup, modifierSuffix, priceLine } from './pos-pricing.util';

const size: ModifierGroup = { id: 'g1', name: 'Size', minSelect: 1, maxSelect: 1, options: [{ id: 's', name: 'Small', priceDeltaMinor: 0 }, { id: 'l', name: 'Large', priceDeltaMinor: 100 }] };
const extras: ModifierGroup = { id: 'g2', name: 'Extras', minSelect: 0, maxSelect: 2, options: [{ id: 'shot', name: 'Extra shot', priceDeltaMinor: 80 }, { id: 'oat', name: 'Oat milk', priceDeltaMinor: 60 }, { id: 'old', name: 'Gone', priceDeltaMinor: 10, active: false }] };

describe('line pricing (G4.5, pure, minor units)', () => {
  it('list price + chosen option deltas; a price book replaces the BASE (deltas still add)', () => {
    const r = priceLine({ listPriceMinor: 500, groups: [size, extras], choices: [{ groupId: 'g1', optionIds: ['l'] }, { groupId: 'g2', optionIds: ['shot', 'oat'] }] });
    expect(r).toMatchObject({ ok: true, unitPriceMinor: 740, baseMinor: 500, fromBook: false });
    const b = priceLine({ listPriceMinor: 500, bookPriceMinor: 420, groups: [size], choices: [{ groupId: 'g1', optionIds: ['l'] }] });
    expect(b).toMatchObject({ ok: true, unitPriceMinor: 520, baseMinor: 420, fromBook: true });
    expect(modifierSuffix((r as any).modifiers)).toBe(' (Large, Extra shot, Oat milk)');
  });
  it('a required group must be answered; at most maxSelect; unknown / inactive options and groups not on the product are refused', () => {
    expect(priceLine({ listPriceMinor: 500, groups: [size], choices: [] })).toMatchObject({ ok: false, error: { code: 'MODIFIER_REQUIRED' } });
    expect(priceLine({ listPriceMinor: 500, groups: [extras], choices: [{ groupId: 'g2', optionIds: ['shot', 'oat', 'x'] }] })).toMatchObject({ ok: false, error: { code: 'MODIFIER_TOO_MANY' } });
    expect(priceLine({ listPriceMinor: 500, groups: [extras], choices: [{ groupId: 'g2', optionIds: ['old'] }] })).toMatchObject({ ok: false, error: { code: 'MODIFIER_OPTION_UNKNOWN' } });
    expect(priceLine({ listPriceMinor: 500, groups: [size], choices: [{ groupId: 'gX', optionIds: ['l'] }, { groupId: 'g1', optionIds: ['s'] }] })).toMatchObject({ ok: false, error: { code: 'MODIFIER_NOT_ON_PRODUCT' } });
    expect(priceLine({ listPriceMinor: 500, groups: [size], choices: [{ groupId: 'g1', optionIds: ['s'] }, { groupId: 'g1', optionIds: ['l'] }] })).toMatchObject({ ok: false, error: { code: 'MODIFIER_GROUP_TWICE' } });
    // the same option twice counts once
    expect(priceLine({ listPriceMinor: 500, groups: [extras], choices: [{ groupId: 'g2', optionIds: ['shot', 'shot'] }] })).toMatchObject({ ok: true, unitPriceMinor: 580 });
  });
  it('no groups and no choices = the list price exactly; a negative result is refused', () => {
    expect(priceLine({ listPriceMinor: 999, groups: [], choices: null })).toMatchObject({ ok: true, unitPriceMinor: 999, modifiers: [] });
    expect(priceLine({ listPriceMinor: 50, groups: [{ id: 'g', name: 'No cheese', minSelect: 0, maxSelect: 1, options: [{ id: 'n', name: 'No cheese', priceDeltaMinor: -100 }] }], choices: [{ groupId: 'g', optionIds: ['n'] }] })).toMatchObject({ ok: false, error: { code: 'PRICE_BELOW_ZERO' } });
  });
  it('a book is in force only when active and inside its window', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(bookActive({ active: true }, now)).toBe(true);
    expect(bookActive({ active: false }, now)).toBe(false);
    expect(bookActive({ startsAt: '2026-11-11T00:00:00Z' }, now)).toBe(false);
    expect(bookActive({ endsAt: '2026-11-10T12:00:00Z' }, now)).toBe(false);
    expect(bookActive(null, now)).toBe(false);
  });
});
