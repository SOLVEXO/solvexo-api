import { checkAccountTitle, nameTokens, namesMatch } from './account-title-match.util';

describe('nameTokens', () => {
  it('ignores case, punctuation, titles and company suffixes', () => {
    expect(nameTokens('Mr. Ali  RAZA')).toEqual(['ali', 'raza']);
    expect(nameTokens('M/S Noor Fabrics (Pvt) Ltd.')).toEqual(['noor', 'fabrics']);
    expect(nameTokens(null)).toEqual([]);
    expect(nameTokens('   ')).toEqual([]);
  });
});

describe('namesMatch', () => {
  it('matches the same name in any order, case and spelling of titles', () => {
    expect(namesMatch('Ali Raza', 'raza ali')).toBe(true);
    expect(namesMatch('MR ALI RAZA', 'Ali Raza')).toBe(true);
    expect(namesMatch('Noor Fabrics Pvt Ltd', 'Noor Fabrics')).toBe(true);
  });
  it('matches a fuller name that contains the shorter one, and a business account with the owner as part of the title', () => {
    expect(namesMatch('Ali Raza Khan', 'Ali Raza')).toBe(true);
    expect(namesMatch('Muhammad Ali Raza', 'Ali Raza')).toBe(true);
  });
  it('a one-word name matches when that word is shared', () => {
    expect(namesMatch('Ali', 'Ali Raza')).toBe(true);
    expect(namesMatch('Ali', 'Bilal Raza')).toBe(false);
  });
  it('does NOT match when only one common word is shared between full names', () => {
    expect(namesMatch('Ali Raza', 'Bilal Raza')).toBe(false);
    expect(namesMatch('Muhammad Ali', 'Muhammad Bilal')).toBe(false);
  });
  it('does not match unrelated names, and empty values never match', () => {
    expect(namesMatch('Someone Else Entirely', 'Jane Seller')).toBe(false);
    expect(namesMatch('', 'Ali')).toBe(false);
    expect(namesMatch('Ali', null)).toBe(false);
    expect(namesMatch('Pvt Ltd', 'Ltd')).toBe(false); // only noise words
  });
});

describe('checkAccountTitle', () => {
  it('passes when ANY known name matches (owner, legal business name or authorized contact)', () => {
    expect(checkAccountTitle('Noor Fabrics', ['Bilal Ahmed', 'Noor Fabrics Pvt Ltd', 'Ayesha Khan']).flagged).toBe(false);
    expect(checkAccountTitle('Ayesha Khan', ['Bilal Ahmed', 'Noor Fabrics', 'Ayesha Khan']).flagged).toBe(false);
  });
  it('flags a holder that matches none, and says which names it was compared with', () => {
    const r = checkAccountTitle('Zeeshan Traders', ['Bilal Ahmed', 'Noor Fabrics']);
    expect(r.flagged).toBe(true);
    expect(r.note).toContain('"Zeeshan Traders"');
    expect(r.note).toContain('"Bilal Ahmed"');
    expect(r.note).toContain('"Noor Fabrics"');
    expect(r.note).toContain('not blocked');
  });
  it('never flags when there is nothing to compare with or no holder was given', () => {
    expect(checkAccountTitle('Anyone', [null, undefined, '  ']).flagged).toBe(false);
    expect(checkAccountTitle('', ['Ali']).flagged).toBe(false);
    expect(checkAccountTitle(null, ['Ali']).flagged).toBe(false);
  });
  it('ignores duplicate names in the note', () => {
    expect(checkAccountTitle('Zed', ['Ali', 'Ali', ' Ali ']).comparedWith).toEqual(['Ali']);
  });
});
