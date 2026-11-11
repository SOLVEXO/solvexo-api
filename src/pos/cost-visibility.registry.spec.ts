/* eslint-disable prettier/prettier */
import * as fs from 'fs';
import * as path from 'path';
import { GLOBAL_COST_KEYS, NOT_COST, SCOPED_COST_KEYS, carriesCost, costKeysFor, stripCost } from './cost-visibility.registry';

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

  it('strips global keys everywhere and scoped keys only on their routes', () => {
    const body = { success: true, data: { items: [{ name: 'Milk', costPriceMinor: 120, valueMinor: 1200, totalMinor: 500 }], denominations: [{ valueMinor: 500000, count: 1 }] } };
    const inv = stripCost(body, costKeysFor('/api/pos/inventory/stock/s1'));
    expect(inv.data.items[0]).toEqual({ name: 'Milk', totalMinor: 500 });
    const close = stripCost(body, costKeysFor('/api/pos/sessions/last-close'));
    expect(close.data.denominations[0].valueMinor).toBe(500000); // a note's face value is not cost
    expect(close.data.items[0]).toEqual({ name: 'Milk', valueMinor: 1200, totalMinor: 500 });
    const sup = stripCost(body, costKeysFor('/api/pos/supply/orders/s1'));
    expect(sup.data.items[0]).toEqual({ name: 'Milk', valueMinor: 1200 }); // PO totals go; valueMinor is cost on inventory routes only
    expect(carriesCost({ a: [{ b: { marginPercent: 3 } }] }, GLOBAL_COST_KEYS)).toBe(true);
    expect(carriesCost({ a: [{ totalMinor: 3 }] }, GLOBAL_COST_KEYS)).toBe(false);
  });
});
