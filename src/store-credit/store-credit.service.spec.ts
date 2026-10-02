/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { StoreCreditService } from './store-credit.service';

const STORE = 'store-1';
const CUST = 'cust-1';
const actor = { actorId: 'seller-1', actorRole: 'seller' as const };

/** Minimal in-memory stand-in for the StoreCreditTransaction model (just what the service calls). */
function makeModel() {
  const rows: any[] = [];
  let seq = 0;
  const now = () => new Date();
  const matches = (r: any, f: any): boolean => {
    for (const [k, v] of Object.entries(f)) {
      if (k === '$or') { if (!(v as any[]).some((sub) => matches(r, sub))) return false; continue; }
      const val = r[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o: any = v;
        if ('$gt' in o && !(val != null && val > o.$gt)) return false;
        if ('$gte' in o && !(val != null && val >= o.$gte)) return false;
        if ('$lte' in o && !(val != null && val <= o.$lte)) return false;
        if ('$ne' in o && val === o.$ne) return false;
        if ('$type' in o) return typeof val === 'string';
      } else if (val !== v && !(v === null && val == null)) return false;
    }
    return true;
  };
  const lean = (arr: any[]) => ({ lean: async () => arr.map((r) => ({ ...r })), sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => arr }) }) }), limit: () => ({ lean: async () => arr.map((r) => ({ ...r })) }) });
  const model: any = {
    rows,
    create: jest.fn(async (doc: any) => {
      if (doc.idemKey && rows.some((r) => r.storeId === doc.storeId && r.type === doc.type && r.idemKey === doc.idemKey)) {
        throw Object.assign(new Error('dup'), { code: 11000 });
      }
      const row = { remaining: 0, expiresAt: null, expiredHandled: false, consumed: [], idemKey: null, ...doc, _id: `tx${++seq}`, createdAt: new Date(now().getTime() + seq) };
      rows.push(row);
      return row;
    }),
    exists: jest.fn(async (f: any) => (rows.some((r) => matches(r, f)) ? { _id: 1 } : null)),
    find: jest.fn((f: any) => lean(rows.filter((r) => matches(r, f)))),
    aggregate: jest.fn(async (pipe: any[]) => {
      const sel = rows.filter((r) => matches(r, pipe[0].$match));
      return sel.length ? [{ _id: null, total: sel.reduce((s, r) => s + r.remaining, 0) }] : [];
    }),
    updateOne: jest.fn(async (f: any, u: any) => {
      const { _id, ...rest } = f;
      const r = rows.find((x) => x._id === _id && matches(x, rest));
      if (!r) return { modifiedCount: 0 };
      if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) r[k] = Math.round((r[k] + (v as number)) * 100) / 100;
      return { modifiedCount: 1 };
    }),
    findOneAndUpdate: jest.fn(async (f: any, u: any) => {
      const r = rows.find((x) => x._id === f._id && x.expiredHandled === f.expiredHandled && x.remaining > 0);
      if (!r) return null;
      const before = { ...r };
      Object.assign(r, u.$set);
      return before;
    }),
  };
  return model;
}

function setup(currency = 'USD') {
  const txModel = makeModel();
  const db: any = {
    repositories: {
      storeCreditTransactionModel: txModel,
      storeModel: { findById: () => ({ select: () => ({ lean: async () => ({ baseCurrency: currency }) }) }) },
      userModel: { findById: () => ({ select: () => ({ lean: async () => ({ storeId: STORE }) }) }) },
      orderModel: { exists: jest.fn().mockResolvedValue(null) },
    },
  };
  const activity = { log: jest.fn() };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new StoreCreditService(db, activity as any, notifications as any);
  return { service, txModel, activity, notifications };
}

describe('StoreCreditService', () => {
  it('issues credit, then adds to it, and reports the spendable balance', async () => {
    const { service, txModel } = setup();
    const r1 = await service.adjust(STORE, CUST, { amount: 50, note: 'welcome' }, actor);
    expect(r1.data.balance).toBe(50);
    expect(txModel.rows[0].type).toBe('issue');
    const r2 = await service.adjust(STORE, CUST, { amount: 25 }, actor);
    expect(r2.data.balance).toBe(75);
    expect(txModel.rows[1].type).toBe('adjust_credit');
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(75);
  });

  it('rejects a zero amount and a past expiry date', async () => {
    const { service } = setup();
    await expect(service.adjust(STORE, CUST, { amount: 0 }, actor)).rejects.toThrow(BadRequestException);
    await expect(
      service.adjust(STORE, CUST, { amount: 10, expiresAt: new Date(Date.now() - 1000) }, actor),
    ).rejects.toThrow(/future/);
  });

  it('removes credit up to the balance and refuses to go below zero', async () => {
    const { service } = setup();
    await service.adjust(STORE, CUST, { amount: 40 }, actor);
    const r = await service.adjust(STORE, CUST, { amount: -15 }, actor);
    expect(r.data.balance).toBe(25);
    await expect(service.adjust(STORE, CUST, { amount: -30 }, actor)).rejects.toThrow(/at most 25/);
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(25);
  });

  it('spends the soonest-expiring credit first, never-expiring credit last', async () => {
    const { service, txModel } = setup();
    await service.adjust(STORE, CUST, { amount: 30 }, actor); // never expires
    await service.adjust(STORE, CUST, { amount: 20, expiresAt: new Date(Date.now() + 86_400_000) }, actor);
    await service.redeemAtOrderPlacement(STORE, CUST, 25, 'chk-1', 'ord-1');
    const [forever, expiring] = txModel.rows;
    expect(expiring.remaining).toBe(0);   // 20 from the expiring lot…
    expect(forever.remaining).toBe(25);   // …then 5 from the never-expiring one
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(25);
  });

  it('redeem is idempotent per checkout (a retry never spends twice)', async () => {
    const { service } = setup();
    await service.adjust(STORE, CUST, { amount: 50 }, actor);
    expect(await service.redeemAtOrderPlacement(STORE, CUST, 20, 'chk-1', 'ord-1')).toBe(true);
    expect(await service.redeemAtOrderPlacement(STORE, CUST, 20, 'chk-1', 'ord-1')).toBe(true);
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(30);
  });

  it('redeem that cannot be covered takes nothing and raises a review alert', async () => {
    const { service, activity } = setup();
    await service.adjust(STORE, CUST, { amount: 10 }, actor);
    expect(await service.redeemAtOrderPlacement(STORE, CUST, 25, 'chk-2', 'ord-2')).toBe(false);
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(10);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'store_credit_redeem_failed', isSecurityAlert: true }));
  });

  it('assertCovers throws when the balance fell short and passes otherwise', async () => {
    const { service } = setup();
    await service.adjust(STORE, CUST, { amount: 10 }, actor);
    await expect(service.assertCovers(STORE, CUST, 10)).resolves.toBeUndefined();
    await expect(service.assertCovers(STORE, CUST, 10.5)).rejects.toThrow(/no longer covers/);
    await expect(service.assertCovers(STORE, CUST, 0)).resolves.toBeUndefined();
  });

  it('restoreOnRefund and creditFromRefund add a lot once per event key', async () => {
    const { service, notifications } = setup();
    expect(await service.restoreOnRefund(STORE, CUST, 12, 'ord-1', 'cancel:ord-1:a')).toBe(true);
    expect(await service.restoreOnRefund(STORE, CUST, 12, 'ord-1', 'cancel:ord-1:a')).toBe(false);
    expect(await service.creditFromRefund(STORE, CUST, 8, 'ord-1', 'refund:ord-1:0', 'goodwill', actor)).toBe(true);
    expect(await service.creditFromRefund(STORE, CUST, 8, 'ord-1', 'refund:ord-1:0', 'goodwill', actor)).toBe(false);
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(20);
    expect(notifications.notify).toHaveBeenCalledTimes(1); // only the refund-to-credit notifies
  });

  it('ignores non-positive restore amounts', async () => {
    const { service } = setup();
    expect(await service.restoreOnRefund(STORE, CUST, 0, 'o', 'k')).toBe(false);
    expect(await service.getSpendableBalance(STORE, CUST)).toBe(0);
  });

  it('expired lots stop counting immediately and the sweep zeroes them once with a ledger row', async () => {
    const { service, txModel } = setup();
    await service.adjust(STORE, CUST, { amount: 10, expiresAt: new Date(Date.now() + 60_000) }, actor);
    await service.adjust(STORE, CUST, { amount: 5 }, actor);
    const future = new Date(Date.now() + 120_000);
    expect(await service.getSpendableBalance(STORE, CUST, 'USD', future)).toBe(5);

    const r1 = await service.expireDueLots(future);
    expect(r1.expired).toBe(1);
    expect(txModel.rows.find((r: any) => r.type === 'expire')?.amount).toBe(-10);
    const r2 = await service.expireDueLots(future);
    expect(r2.expired).toBe(0);
  });
});
