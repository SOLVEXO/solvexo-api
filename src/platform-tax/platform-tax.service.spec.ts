/* eslint-disable prettier/prettier */
import { PlatformTaxService } from './platform-tax.service';

function build(opts: { storeCountry?: string | null; baseCurrency?: string; gatewayThrows?: boolean; stores?: any[] } = {}) {
  let doc: any = null;
  const updates: any[] = [];
  const model: any = {
    findOne: () => ({ lean: async () => (doc ? JSON.parse(JSON.stringify(doc)) : null) }),
    updateOne: async (filter: any, update: any) => {
      updates.push(update);
      if (update.$set && !('rates.$.stripeTaxRateId' in update.$set)) doc = { ...(doc ?? { key: 'platform' }), ...update.$set };
      else if (doc && update.$set?.['rates.$.stripeTaxRateId']) {
        doc.rates = doc.rates.map((r: any) => (r.id === filter['rates.id'] ? { ...r, stripeTaxRateId: update.$set['rates.$.stripeTaxRateId'] } : r));
      }
    },
  };
  const stores = opts.stores ?? [{ _id: 's1', country: opts.storeCountry ?? null, baseCurrency: opts.baseCurrency ?? null }];
  const db: any = {
    repositories: {
      storeModel: {
        findById: () => ({ select: () => ({ lean: async () => ({ country: opts.storeCountry ?? null, baseCurrency: opts.baseCurrency ?? null }) }) }),
        find: () => ({ select: () => ({ lean: async () => stores }) }),
      },
      sellerPlatformSubscriptionModel: { find: () => ({ select: () => ({ limit: () => ({ lean: async () => stores.map((s: any) => ({ storeId: s._id })) }) }) }) },
    },
  };
  const created: any[] = [];
  const gateway: any = {
    getOrCreateTaxRate: async (p: any) => {
      if (opts.gatewayThrows) throw new Error('stripe down');
      created.push(p);
      return p.existingId ?? `txr_${created.length}`;
    },
  };
  const logs: any[] = [];
  const svc = new PlatformTaxService(model, db, gateway, { log: (x: any) => logs.push(x) } as any);
  return { svc, created, updates, getDoc: () => doc };
}

const pk = (over: any = {}) => ({ country: 'PK', label: 'Sales Tax', ratePercent: 17, status: 'confirmed', effectiveFrom: null, ...over });

async function rejects(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as Error).message; }
  return '';
}

describe('PlatformTaxService.update', () => {
  it('rejects a tax number with odd characters', async () => {
    const { svc } = build();
    expect((await rejects(svc.update({ ntn: 'bad;number' } as any, 'a1'))).length > 0).toBe(true);
  });
  it('keeps the Stripe rate id only while percentage/label/country are unchanged', async () => {
    const { svc, getDoc } = build();
    await svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    getDoc().rates[0].stripeTaxRateId = 'txr_old';
    await svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    expect(getDoc().rates[0].stripeTaxRateId).toBe('txr_old');
    await svc.update({ rates: [pk({ id: 'r1', ratePercent: 18 })] } as any, 'a1');
    expect(getDoc().rates[0].stripeTaxRateId).toBe(null);
  });
  it('refuses two confirmed rates for one country starting on the same date', async () => {
    const { svc } = build();
    const msg = await rejects(svc.update({ rates: [pk({ id: 'a' }), pk({ id: 'b', ratePercent: 18 })] } as any, 'a1'));
    expect(msg.includes('same date')).toBe(true);
  });
});

describe('PlatformTaxService.resolveForStore / taxRateIdForStore', () => {
  it('uses the store country to pick the confirmed rate', async () => {
    const { svc } = build({ storeCountry: 'PK' });
    await svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    const r = await svc.resolveForStore('s1');
    expect(r.country).toBe('PK');
    expect(r.rate?.ratePercent).toBe(17);
  });
  it('charges nothing for a draft rate or an unlisted country', async () => {
    const draft = build({ storeCountry: 'PK' });
    await draft.svc.update({ rates: [pk({ id: 'r1', status: 'draft' })] } as any, 'a1');
    expect(await draft.svc.taxRateIdForStore('s1')).toBe(null);
    const other = build({ storeCountry: 'AE' });
    await other.svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    expect(await other.svc.taxRateIdForStore('s1')).toBe(null);
  });
  it('creates the Stripe tax rate once and remembers its id', async () => {
    const { svc, created, getDoc } = build({ storeCountry: 'PK' });
    await svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    expect(await svc.taxRateIdForStore('s1')).toBe('txr_1');
    expect(getDoc().rates[0].stripeTaxRateId).toBe('txr_1');
    expect(await svc.taxRateIdForStore('s1')).toBe('txr_1');
    expect(created.length).toBe(2); // second call passes existingId, the gateway returns it unchanged
    expect(created[1].existingId).toBe('txr_1');
  });
  it('never throws when Stripe fails: the sale goes ahead and the error is only logged', async () => {
    const { svc } = build({ storeCountry: 'PK', gatewayThrows: true });
    await svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    expect(await svc.taxRateIdForStore('s1')).toBe(null);
  });
});

describe('PlatformTaxService.quoteForStore', () => {
  it('adds tax on top for a confirmed rate', async () => {
    const { svc } = build({ storeCountry: 'PK' });
    await svc.update({ rates: [pk({ id: 'r1', ratePercent: 17 })] } as any, 'a1');
    expect(await svc.quoteForStore('s1', 10)).toEqual({ netUSD: 10, taxUSD: 1.7, totalUSD: 11.7, ratePercent: 17, label: 'Sales Tax', country: 'PK' });
  });
  it('quotes zero tax (net = total) when no rate applies', async () => {
    const { svc } = build({ storeCountry: 'AE' });
    await svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    const q = await svc.quoteForStore('s1', 10);
    expect(q.taxUSD).toBe(0);
    expect(q.totalUSD).toBe(10);
  });
});

describe('PlatformTaxService.coverageGaps', () => {
  it('lists paying countries that have no usable rate, most stores first', async () => {
    const stores = [
      { _id: 'a', country: 'PK' }, { _id: 'b', country: 'AE' }, { _id: 'c', country: 'AE' }, { _id: 'd', country: 'GB' }, { _id: 'e', country: null, baseCurrency: null },
    ];
    const { svc } = build({ stores });
    await svc.update({ rates: [pk({ id: 'r1' }), pk({ id: 'r2', country: 'GB', status: 'draft' })] } as any, 'a1');
    expect(await svc.coverageGaps()).toEqual([
      { country: 'AE', stores: 2, reason: 'not_listed' },
      { country: 'GB', stores: 1, reason: 'not_confirmed' },
      { country: 'UNKNOWN', stores: 1, reason: 'no_country' },
    ]);
  });
});

describe('PlatformTaxService.rateForStore', () => {
  it('returns the percentage + label for the seller country, or null', async () => {
    const pkStore = build({ storeCountry: 'PK' });
    await pkStore.svc.update({ rates: [pk({ id: 'r1', ratePercent: 16, label: 'PST' })] } as any, 'a1');
    expect(await pkStore.svc.rateForStore('s1')).toEqual({ ratePercent: 16, label: 'PST', country: 'PK' });
    const aeStore = build({ storeCountry: 'AE' });
    await aeStore.svc.update({ rates: [pk({ id: 'r1' })] } as any, 'a1');
    expect(await aeStore.svc.rateForStore('s1')).toBe(null);
  });
});
