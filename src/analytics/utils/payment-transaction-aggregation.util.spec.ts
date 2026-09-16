/* eslint-disable prettier/prettier */
import { deriveRatePerUSD } from './payment-transaction-aggregation.util';

describe('deriveRatePerUSD — Phase 8 PaymentTransaction USD normalization', () => {
  it('finds the snapshot matching the transaction\'s own currency and returns its rate', () => {
    const fxSnapshots = [
      { currency: 'USD', ratePerUSD: 1 },
      { currency: 'PKR', ratePerUSD: 280 },
    ];
    expect(deriveRatePerUSD(fxSnapshots, 'PKR')).toBe(280);
  });

  it('returns 1 for a USD transaction (USD is its own pivot)', () => {
    const fxSnapshots = [{ currency: 'USD', ratePerUSD: 1 }];
    expect(deriveRatePerUSD(fxSnapshots, 'USD')).toBe(1);
  });

  it('returns null — never a guess — when no snapshot exists at all (a historical row predating fxSnapshots)', () => {
    expect(deriveRatePerUSD(undefined, 'PKR')).toBeNull();
    expect(deriveRatePerUSD([], 'PKR')).toBeNull();
  });

  it('returns null when the transaction\'s currency has no matching snapshot entry', () => {
    const fxSnapshots = [{ currency: 'USD', ratePerUSD: 1 }];
    expect(deriveRatePerUSD(fxSnapshots, 'PKR')).toBeNull();
  });

  it('returns null when the currency itself was never recorded on the transaction', () => {
    const fxSnapshots = [{ currency: 'USD', ratePerUSD: 1 }];
    expect(deriveRatePerUSD(fxSnapshots, undefined)).toBeNull();
  });

  it('treats a zero/negative snapshot rate (corrupt data) as unconvertible rather than dividing by it', () => {
    const fxSnapshots = [{ currency: 'PKR', ratePerUSD: 0 }];
    expect(deriveRatePerUSD(fxSnapshots, 'PKR')).toBeNull();
  });
});
