import { parsePortalOrigins } from './portal-origins.util';

/** PORTAL_ORIGINS feeds both CORS and the CSRF Origin check for cookie sessions, so a sloppy entry would widen both. */
describe('parsePortalOrigins', () => {
  it('keeps exact https origins and http only for localhost', () => {
    expect(parsePortalOrigins('https://account.solvexo.store, http://localhost:5173 ,http://127.0.0.1:4173'))
      .toEqual(['https://account.solvexo.store', 'http://localhost:5173', 'http://127.0.0.1:4173']);
  });
  it.each([
    ['wildcard', 'https://*.solvexo.store'],
    ['plain http on a real host', 'http://account.solvexo.store'],
    ['a path', 'https://account.solvexo.store/app'],
    ['a trailing slash', 'https://account.solvexo.store/'],
    ['not a URL', 'account.solvexo.store'],
    ['another scheme', 'javascript:alert(1)'],
  ])('drops %s', (_n, entry) => {
    expect(parsePortalOrigins(`${entry},https://ok.example.com`)).toEqual(['https://ok.example.com']);
  });
  it('is empty when unset', () => { expect(parsePortalOrigins(undefined)).toEqual([]); expect(parsePortalOrigins('')).toEqual([]); });
});
