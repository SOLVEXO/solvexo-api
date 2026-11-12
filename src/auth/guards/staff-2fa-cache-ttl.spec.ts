import { STAFF_2FA_CACHE_TTL_MS, staffTwoFactorCache, clearStaffTwoFactorCache } from './permissions.guard';

describe('staff 2FA verdict cache', () => {
  it('trusts a verdict for at most 10 s so other API instances catch up fast', () => {
    expect(STAFF_2FA_CACHE_TTL_MS <= 10_000).toBe(true);
  });
  it('can be cleared at once on the instance that changed the policy', () => {
    staffTwoFactorCache.set('k', { at: Date.now(), blocked: true });
    clearStaffTwoFactorCache();
    expect(staffTwoFactorCache.size).toBe(0);
  });
});
