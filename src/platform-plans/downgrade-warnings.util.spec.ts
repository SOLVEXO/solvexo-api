import { buildDowngradeWarnings, type DowngradeUsage } from './downgrade-warnings.util';

const usage = (over: Partial<DowngradeUsage> = {}): DowngradeUsage => ({ products: 10, staff: 1, locations: 1, currencies: null, emailsThisMonth: 0, wholesaleCatalogs: 0, ...over });
const basic: any = { maxProducts: 25, maxStaffAccounts: 1, maxPosLocations: 1, maxMarkets: 3, monthlyEmailSends: 2000, maxB2BCatalogs: 1, emailCampaignsAllowed: true, customDomainAllowed: true };
const grow: any = { ...basic, maxProducts: -1, maxStaffAccounts: 5, maxPosLocations: 3, maxMarkets: 5, monthlyEmailSends: 10000, maxB2BCatalogs: 3, loyaltyProgramAllowed: true, prioritySupport: true, digitalCoursesAllowed: true };

describe('downgrade warnings: numbers', () => {
  it('says nothing when the store fits inside the new plan', () => {
    expect(buildDowngradeWarnings(usage(), grow, basic).usageWarnings).toEqual([]);
  });
  it('warns about products, staff and locations over the new limit', () => {
    const w = buildDowngradeWarnings(usage({ products: 80, staff: 4, locations: 2 }), grow, basic).usageWarnings;
    expect(w.map((x) => x.label)).toEqual(['Products', 'Staff accounts', 'POS locations']);
    expect(w[0]).toEqual({ label: 'Products', used: 80, newLimit: 25 });
  });
  it('warns when this month\'s marketing emails are already above the new plan\'s allowance', () => {
    const w = buildDowngradeWarnings(usage({ emailsThisMonth: 5000 }), grow, basic).usageWarnings;
    expect(w).toEqual([{ label: 'Marketing emails this month', used: 5000, newLimit: 2000 }]);
  });
  it('warns when the store has more wholesale catalogs than the new plan allows', () => {
    const w = buildDowngradeWarnings(usage({ wholesaleCatalogs: 3 }), grow, basic).usageWarnings;
    expect(w).toEqual([{ label: 'Wholesale catalogs', used: 3, newLimit: 1 }]);
  });
  it('an unlimited new limit (-1) never warns', () => {
    expect(buildDowngradeWarnings(usage({ products: 9999, wholesaleCatalogs: 50 }), basic, { ...grow, maxB2BCatalogs: -1 }).usageWarnings).toEqual([]);
  });
  it('currencies only count when the seller picked a list', () => {
    expect(buildDowngradeWarnings(usage({ currencies: null }), grow, basic).usageWarnings).toEqual([]);
    expect(buildDowngradeWarnings(usage({ currencies: 5 }), grow, basic).usageWarnings).toEqual([{ label: 'Checkout currencies (markets)', used: 5, newLimit: 3 }]);
  });
  it('exactly at the limit is fine', () => {
    expect(buildDowngradeWarnings(usage({ products: 25, emailsThisMonth: 2000, wholesaleCatalogs: 1 }), grow, basic).usageWarnings).toEqual([]);
  });
});

describe('downgrade warnings: features that go away', () => {
  it('lists what the current plan has and the new one does not', () => {
    const { lostFeatures } = buildDowngradeWarnings(usage(), grow, basic);
    expect(lostFeatures).toEqual(['Loyalty & rewards program', 'Courses', 'Priority support']);
  });
  it('lists nothing when moving up or sideways', () => {
    expect(buildDowngradeWarnings(usage(), basic, grow).lostFeatures).toEqual([]);
    expect(buildDowngradeWarnings(usage(), grow, grow).lostFeatures).toEqual([]);
  });
  it('a feature the current plan never had is not "lost"', () => {
    expect(buildDowngradeWarnings(usage(), basic, { ...basic, customDomainAllowed: false }).lostFeatures).toEqual(['Custom domain']);
  });
});
