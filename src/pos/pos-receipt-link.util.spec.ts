/* eslint-disable prettier/prettier */
import { offlineLinkBaseOf } from './pos-receipt-link.util';

/** G5.2.0b: the receipt link base follows RECEIPT_PUBLIC_URL (the web domain), falling back to API_PUBLIC_URL. */
describe('receipt link base', () => {
  const load = (env: Record<string, string | undefined>) => {
    const old = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    let mod: any;
    jest.isolateModules(() => { mod = require('./pos-receipt-link.util'); });
    process.env = old;
    return mod.offlineLinkBaseOf as typeof offlineLinkBaseOf;
  };
  it('RECEIPT_PUBLIC_URL set → the QR / share link is on the web domain', () => {
    expect(load({ API_PUBLIC_URL: 'https://api.solvexo.store', RECEIPT_PUBLIC_URL: 'https://solvexo.store/' })('dev-coffee').receiptLinkBase).toBe('https://solvexo.store/r/s/dev-coffee/');
  });
  it('unset → falls back to API_PUBLIC_URL (nothing changes)', () => {
    expect(load({ API_PUBLIC_URL: 'https://api.solvexo.store', RECEIPT_PUBLIC_URL: undefined })('dev-coffee').receiptLinkBase).toBe('https://api.solvexo.store/r/s/dev-coffee/');
  });
  it('an explicit origin (a future per-store domain) wins; a bad slug gives no base', () => {
    expect(offlineLinkBaseOf('shop-1', 'https://receipts.shop.pk').receiptLinkBase).toBe('https://receipts.shop.pk/r/s/shop-1/');
    expect(offlineLinkBaseOf('Bad Slug!').receiptLinkBase).toBeNull();
  });
});
