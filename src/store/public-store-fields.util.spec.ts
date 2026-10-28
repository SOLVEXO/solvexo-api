import { pickPublicStoreFields } from './public-store-fields.util';

describe('pickPublicStoreFields', () => {
  it('keeps only the public fields and drops every private one, even ones added later', () => {
    const out = pickPublicStoreFields({
      _id: 's1', name: 'Shop', slug: 'shop', logo: 'l', privacyMode: 'password', contactEmail: 'a@b.c',
      taxId: '123', taxRegistered: true, aiCredits: 50, dashboardMetrics: ['x'], stripeConnectAccountId: 'acct', sellerId: 'sel',
      registers: [{}], customDomains: [{}], verificationStatus: 'ok', someFutureSecret: 'zzz',
    });
    expect(Object.keys(out).sort()).toEqual(['_id', 'contactEmail', 'logo', 'name', 'privacyMode', 'slug']);
  });
});
