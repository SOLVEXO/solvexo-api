import { AiCreditsService, balanceAfterReset, upgradeExtra } from './ai-credits.service';
import { EntitlementsService, TRIAL_AI_CREDITS } from './entitlements.service';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** The AI credit wallet follows the store's plan; bought credits survive the monthly reset. Plain describe/it/expect (also runs on scripts/mini-jest.cjs). */
function setup(allowance: { value: number }, wallet?: any) {
  const wallets = new FakeModel({ ledger: [], bonusBalance: 0 });
  if (wallet) wallets.rows.push({ _id: 'w1', storeId: 's1', sellerId: 'sel1', ledger: [], bonusBalance: 0, ...wallet });
  const db: any = { repositories: { aiCreditsWalletModel: wallets } };
  const entitlements: any = { getLimits: async () => ({ aiCreditsPerMonth: allowance.value }) };
  return { wallets, svc: new AiCreditsService(db, entitlements) };
}

describe('AI credits: pure rules', () => {
  it('the monthly allowance only ever goes UP the moment the plan allows more', () => {
    expect(upgradeExtra(100, 500)).toBe(400);
    expect(upgradeExtra(500, 100)).toBe(0);
    expect(upgradeExtra(100, 100)).toBe(0);
    expect(upgradeExtra(0, 50)).toBe(50);
  });

  it('a monthly reset keeps the bought credits that are still unspent, and nothing else', () => {
    // 20 left of the monthly 100 plus 500 bought: 520 in the wallet -> allowance + the 500 bought
    expect(balanceAfterReset(100, 520, 500)).toEqual({ balance: 600, bonus: 500 });
    // the monthly part was spent first, then 300 of the bought ones: 200 left, all of it bought
    expect(balanceAfterReset(100, 200, 500)).toEqual({ balance: 300, bonus: 200 });
    // nothing bought: back to the allowance
    expect(balanceAfterReset(100, 7, 0)).toEqual({ balance: 100, bonus: 0 });
    // everything spent
    expect(balanceAfterReset(100, 0, 500)).toEqual({ balance: 100, bonus: 0 });
  });

  it('a trial gets a small fixed allowance', () => {
    expect(TRIAL_AI_CREDITS).toBe(50);
  });
});

describe('AI credits wallet follows the plan', () => {
  it('is created with the plan allowance', async () => {
    const { svc, wallets } = setup({ value: 100 });
    const w: any = await svc.getOrCreateWallet('s1', 'sel1');
    expect(w.balance).toBe(100);
    expect(w.monthlyAllowance).toBe(100);
    expect(wallets.rows.length).toBe(1);
  });

  it('an upgrade adds the extra allowance at once; credits already used stay used', async () => {
    const allowance = { value: 500 }; // the plan is now Grow
    const { svc } = setup(allowance, { balance: 20, monthlyAllowance: 100 }); // Basic: 80 of 100 used
    const w: any = await svc.getOrCreateWallet('s1', 'sel1');
    expect(w.monthlyAllowance).toBe(500);
    expect(w.balance).toBe(420);
  });

  it('aligning twice (or two requests at once) adds the extra credits only once', async () => {
    const { svc } = setup({ value: 500 }, { balance: 20, monthlyAllowance: 100 });
    await svc.getOrCreateWallet('s1', 'sel1');
    const w: any = await svc.getOrCreateWallet('s1', 'sel1');
    expect(w.balance).toBe(420);
  });

  it('a trial wallet moves up to the plan allowance when the store subscribes', async () => {
    const { svc } = setup({ value: 100 }, { balance: 50, monthlyAllowance: TRIAL_AI_CREDITS });
    const w: any = await svc.getOrCreateWallet('s1', 'sel1');
    // the 50 trial credits still unspent plus the 50 the plan adds = the plan's full 100
    expect(w.balance).toBe(100);
    expect(w.monthlyAllowance).toBe(100);
  });

  it('a downgrade never takes credits away (they may be bought ones); the lower allowance applies from the next reset', async () => {
    const { svc } = setup({ value: 100 }, { balance: 450, monthlyAllowance: 500 });
    const w: any = await svc.getOrCreateWallet('s1', 'sel1');
    expect(w.balance).toBe(450);
    expect(w.monthlyAllowance).toBe(100);
  });

  it('bought credits are kept by the monthly reset', async () => {
    const { svc, wallets } = setup({ value: 100 }, { balance: 20, monthlyAllowance: 100 });
    await svc.grant('s1', 'sel1', 500, 'Purchased 1 x 500 AI credits', { purchased: true });
    expect(wallets.rows[0].balance).toBe(520);
    expect(wallets.rows[0].bonusBalance).toBe(500);
    await svc.resetAllMonthlyAllowances();
    expect(wallets.rows[0].balance).toBe(600);
    expect(wallets.rows[0].bonusBalance).toBe(500);
  });

  it('a normal refund is not a bought credit', async () => {
    const { svc, wallets } = setup({ value: 100 }, { balance: 90, monthlyAllowance: 100 });
    await svc.grant('s1', 'sel1', 5, 'Refund');
    expect(wallets.rows[0].balance).toBe(95);
    expect(wallets.rows[0].bonusBalance).toBe(0);
  });
});

describe('the billing summary shows the real AI credits', () => {
  function summary(wallet: any | null, allowance: number) {
    const lean = (v: any) => () => ({ lean: async () => v });
    const db: any = {
      repositories: {
        sellerPlatformSubscriptionModel: { findOne: lean({ storeId: 's1', status: 'active', platformPlanId: 'p1' }) },
        platformPlanModel: {
          findById: lean({ _id: 'p1', name: 'Basic', limits: { maxProducts: 25, maxStaffAccounts: 1, maxPosLocations: 1, aiCreditsPerMonth: allowance } }),
          findOne: lean(null),
          find: () => ({ sort: () => ({ lean: async () => [] }) }),
        },
        productModel: { countDocuments: async () => 0 },
        staffMemberModel: { countDocuments: async () => 0 },
        storeLocationModel: { countDocuments: async () => 0 },
        platformAddonPurchaseModel: { find: lean([]) },
        aiCreditsWalletModel: { findOne: lean(wallet) },
      },
    };
    return new EntitlementsService(db).getEntitlementsSummary('s1') as Promise<any>;
  }

  it('a store that never used AI shows the full allowance, not "all used"', async () => {
    const s = await summary(null, 100);
    expect(s.aiCredits.monthlyAllowance).toBe(100);
    expect(s.aiCredits.balance).toBe(100);
  });

  it('a wallet that has not seen the upgrade yet already shows the extra allowance', async () => {
    const s = await summary({ balance: 20, monthlyAllowance: 100 }, 500);
    expect(s.aiCredits.balance).toBe(420);
  });

  it('an up-to-date wallet shows its own balance', async () => {
    const s = await summary({ balance: 37, monthlyAllowance: 100 }, 100);
    expect(s.aiCredits.balance).toBe(37);
  });
});

describe('AI credits are spent atomically', () => {
  it('two generations started together cannot both spend the same credits', async () => {
    const { svc, wallets } = setup({ value: 100 }, { balance: 5, monthlyAllowance: 100 });
    const results = await Promise.allSettled([svc.deduct('s1', 'sel1', 5, 'a'), svc.deduct('s1', 'sel1', 5, 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1);
    expect(wallets.rows[0].balance).toBe(0);
  });

  it('refuses when the balance is too low and leaves it untouched', async () => {
    const { svc, wallets } = setup({ value: 100 }, { balance: 3, monthlyAllowance: 100 });
    await expect(svc.deduct('s1', 'sel1', 5, 'x')).rejects.toThrow();
    expect(wallets.rows[0].balance).toBe(3);
  });

  it('writes a spend line with the balance after it', async () => {
    const { svc, wallets } = setup({ value: 100 }, { balance: 20, monthlyAllowance: 100 });
    await svc.deduct('s1', 'sel1', 5, 'AI Studio');
    const line = wallets.rows[0].ledger[wallets.rows[0].ledger.length - 1];
    expect(line.type).toBe('spend');
    expect(line.amount).toBe(-5);
    expect(line.balanceAfter).toBe(15);
  });

  it('a refund and a spend at the same time both land', async () => {
    const { svc, wallets } = setup({ value: 100 }, { balance: 10, monthlyAllowance: 100 });
    await Promise.all([svc.deduct('s1', 'sel1', 4, 'spend'), svc.grant('s1', 'sel1', 4, 'refund')]);
    expect(wallets.rows[0].balance).toBe(10);
  });
});
