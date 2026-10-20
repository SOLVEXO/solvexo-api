/* eslint-disable prettier/prettier */
import { OrderDocumentsService, ORDER_DOCUMENT_DEFAULTS } from './order-documents.service';

function makeService(saved: Record<string, unknown> | null) {
  const updates: any[] = [];
  const repos: any = {
    storeModel: { findById: async () => ({ isDelete: false, sellerId: { toString: () => 'seller-1' }, name: 'Amara', logo: 'https://x/logo.png', contactEmail: 'hi@amara.test', baseCurrency: 'USD' }) },
    orderDocumentSettingsModel: {
      findOne: () => ({ lean: async () => saved }),
      updateOne: async (...args: any[]) => { updates.push(args); return {}; },
    },
  };
  return { svc: new OrderDocumentsService({ repositories: repos } as any), updates };
}

describe('OrderDocumentsService', () => {
  it('an untouched store prints with the built-in defaults and falls back to store details', async () => {
    const { svc } = makeService(null);
    const res = await svc.get('seller-1', 'store-1');
    expect(res.data.settings).toEqual({ ...ORDER_DOCUMENT_DEFAULTS });
    expect(res.data.store.name).toBe('Amara');
    expect(res.data.store.logo).toBe('https://x/logo.png');
  });

  it('saved values override the defaults, the rest stay default', async () => {
    const { svc } = makeService({ watermarkEnabled: true, paperSize: 'a5', unknownField: 'x' });
    const s: any = (await svc.get('seller-1', 'store-1')).data.settings;
    expect(s.watermarkEnabled).toBe(true);
    expect(s.paperSize).toBe('a5');
    expect(s.slipShowPrices).toBe(false);
    expect(s.unknownField).toBe(undefined);
  });

  it('text fields are cleaned and an empty text clears back to the default (null)', async () => {
    const { svc, updates } = makeService(null);
    await svc.update('seller-1', 'store-1', { companyName: '  Amara\u0007 Wears  ', addressText: '', slipShowPrices: true } as any);
    const set = updates[0][1].$set;
    expect(set.companyName).toBe('Amara Wears');
    expect(set.addressText).toBe(null);
    expect(set.slipShowPrices).toBe(true);
  });

  it('refuses a store that belongs to someone else', async () => {
    const { svc } = makeService(null);
    let failed = false;
    try { await svc.update('other', 'store-1', { paperSize: 'a4' } as any); } catch { failed = true; }
    expect(failed).toBe(true);
  });
});
