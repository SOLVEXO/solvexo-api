/* eslint-disable prettier/prettier */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { COST_FIELD_DECISIONS, GLOBAL_COST_KEYS, NOT_COST, SCOPED_COST_KEYS, carriesCost, costKeysFor, stripCost } from './cost-visibility.registry';

/** G4.8: every cost-looking key in the POS / inventory / product sources must be classified — a new DTO field cannot leak cost unnoticed. */
describe('cost field registry', () => {
  const roots = ['src/pos', 'src/inventory', 'src/products', 'src/product-variants', 'src/common'];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
    }
  };
  roots.filter((r) => fs.existsSync(r)).forEach(walk);
  const scoped = new Set(SCOPED_COST_KEYS.flatMap((s) => [...s.keys]));

  it('fails on a cost-looking object key that is neither in the registry nor in NOT_COST', () => {
    const looksCost = /cost|wac|margin|cogs|profit|valuation/i;
    const key = /\b([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g;
    const unclassified: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = key.exec(src))) {
        const k = m[1];
        if (looksCost.test(k) && !GLOBAL_COST_KEYS.has(k) && !scoped.has(k) && !NOT_COST.has(k)) unclassified.push(`${k} (${f})`);
      }
    }
    expect([...new Set(unclassified)]).toEqual([]);
  });

  it('G4.9: the three traced fields are classified as decided — cost everywhere; the customer tax / shipping names stay visible on sales', () => {
    expect(Object.keys(COST_FIELD_DECISIONS).sort()).toEqual(['itemUnitCostMinor', 'shippingCostMinor', 'taxCostMinor']);
    for (const [k, d] of Object.entries(COST_FIELD_DECISIONS)) {
      expect(d.reason.length).toBeGreaterThan(20);
      expect(GLOBAL_COST_KEYS.has(k)).toBe(d.classified === 'cost');
      expect(NOT_COST.has(k)).toBe(d.classified === 'visible');
    }
    const sale = costKeysFor('/api/pos/sales/st1');
    expect(['taxMinor', 'shippingMinor', 'totalMinor'].some(sale)).toBe(false);
    const supply = costKeysFor('/api/pos/supply/st1/purchase-orders');
    expect(['taxMinor', 'shippingMinor', 'shippingCostMinor', 'taxCostMinor'].every(supply)).toBe(true);
  });

  it('strips global keys everywhere and scoped keys only on their routes', () => {
    const body = { success: true, data: { items: [{ name: 'Milk', costPriceMinor: 120, valueMinor: 1200, totalMinor: 500 }], denominations: [{ valueMinor: 500000, count: 1 }] } };
    const inv = stripCost(body, costKeysFor('/api/pos/inventory/stock/s1'));
    expect(inv.data.items[0]).toEqual({ name: 'Milk', totalMinor: 500 });
    const close = stripCost(body, costKeysFor('/api/pos/sessions/last-close'));
    expect(close.data.denominations[0].valueMinor).toBe(500000); // a note's face value is not cost
    expect(close.data.items[0]).toEqual({ name: 'Milk', valueMinor: 1200, totalMinor: 500 });
    const sup = stripCost(body, costKeysFor('/api/pos/supply/orders/s1'));
    expect(sup.data.items[0]).toEqual({ name: 'Milk' }); // under supply every minor amount goes (the pattern)
    // payables aging buckets (and any other minor amount under supply) are caught by the supply pattern
    expect(stripCost({ data: { totals: { d30Minor: 1, d90Minor: 2, currentMinor: 3 }, supplierName: 'X' } }, costKeysFor('/api/pos/supply/payables/s1'))).toEqual({ data: { totals: {}, supplierName: 'X' } });
    expect(carriesCost({ a: [{ b: { marginPercent: 3 } }] }, GLOBAL_COST_KEYS)).toBe(true);
    expect(carriesCost({ a: [{ totalMinor: 3 }] }, GLOBAL_COST_KEYS)).toBe(false);
  });

  it('a hydrated Mongoose document (what a handler may return, e.g. the created sale) and a cycle never blow the stack', () => {
    const Doc = mongoose.model('CostProbe', new mongoose.Schema({ name: String, items: [{ costPriceMinor: Number, qty: Number }], storeId: mongoose.Schema.Types.ObjectId }));
    const doc = new Doc({ name: 'S-1', items: [{ costPriceMinor: 120, qty: 2 }], storeId: new mongoose.Types.ObjectId() });
    expect(carriesCost({ success: true, data: doc }, GLOBAL_COST_KEYS)).toBe(true);
    expect(stripCost({ success: true, data: doc }, GLOBAL_COST_KEYS).data.items[0]).toEqual({ qty: 2, _id: expect.any(String) });
    const plain = new Doc({ name: 'S-2', items: [{ qty: 1 }] });
    expect(carriesCost({ data: plain }, GLOBAL_COST_KEYS)).toBe(false);
    const a: any = { name: 'x' }; a.self = a;
    expect(carriesCost({ data: a }, GLOBAL_COST_KEYS)).toBe(false);
  });
});
