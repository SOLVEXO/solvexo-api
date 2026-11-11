/* eslint-disable prettier/prettier */
/**
 * G4.8 — the COST FIELD REGISTRY: every response key that carries cost or a figure derived from cost (cost price, weighted-average cost, lot cost,
 * stock valuation, PO line costs and totals, payables, gross margin / profit / COGS). When the store's "hide costs from managers" is on and the caller
 * is not the owner, `CostVisibilityInterceptor` removes these keys from every POS response (revenue, quantities and sale totals stay).
 *
 * Two kinds of rule:
 *   · GLOBAL_COST_KEYS — cost wherever they appear in a POS response;
 *   · SCOPED_COST_KEYS — generic money names that are cost only on some routes (`valueMinor` is stock value on inventory routes but a note's face value in
 *     the shift's notes & coins; `totalMinor` is a PO total under supply but a sale total elsewhere).
 * `cost-visibility.registry.spec.ts` scans the source and FAILS when a cost-looking key is neither here nor in NOT_COST — a new field must be classified.
 */
export const GLOBAL_COST_KEYS: ReadonlySet<string> = new Set([
  // product / variant / lot cost (major + minor twins)
  'costPrice', 'costPriceMinor', 'cost', 'costMinor', 'unitCost', 'unitCostMinor', 'costs', 'shippingCost', 'taxCost',
  'wac', 'wacMinor', 'WAC', 'averageCost', 'averageCostMinor', 'costPerUnitMinor',
  // stock valuation
  'stockValueMinor', 'stockValue', 'stockAdjustValueMinor', 'expiredValue', 'totalValue', 'variantsWithoutCost',
  // reports: gross profit, after expenses, margin, COGS, cost coverage
  'grossMargin', 'grossMarginMinor', 'margin', 'marginPercent', 'profit', 'grossProfit', 'grossProfitMinor',
  'afterExpenses', 'afterExpensesMinor', 'costOfGoodsSoldMinor', 'cogs', 'cogsMinor',
  'netWithCostMinor', 'netNoCostMinor', 'costUnknownNetMinor', 'costCoveragePercent',
  // caught by the source scan when the registry was built (supply cost twins)
  'shippingCostMinor', 'taxCostMinor', 'itemUnitCostMinor',
]);

/** Route-scoped: [path prefix (after the host), keys that are cost on those routes only]. */
export const SCOPED_COST_KEYS: ReadonlyArray<{ prefix: string; keys: ReadonlySet<string> }> = [
  // inventory: `value` / `valueMinor` = quantity × cost (stock rows, lots, movements)
  { prefix: '/api/pos/inventory/', keys: new Set(['value', 'valueMinor']) },
  // supply: purchase orders, receipts, supplier returns, payables and the supplier ledger — every amount there is a cost or a payable
  {
    prefix: '/api/pos/supply/',
    keys: new Set([
      'amount', 'amountMinor', 'balance', 'balanceMinor', 'balanceAfter', 'balanceAfterMinor', 'total', 'totalMinor', 'subtotal', 'subtotalMinor',
      'lineTotal', 'lineTotalMinor', 'tax', 'taxMinor', 'shipping', 'shippingMinor', 'credit', 'creditMinor', 'current', 'currentMinor',
      'unit', 'unitMinor', 'prev', 'prevMinor', 'new', 'newMinor', 'paid', 'paidMinor', 'outstanding', 'outstandingMinor', 'overdueMinor',
      'dueMinor', 'aging', 'agingMinor', 'payable', 'payableMinor', 'payables',
    ]),
  },
];

/** Cost-looking names that are NOT cost (settings, sale values, discounts, loyalty) — the scan test accepts these. */
export const NOT_COST: ReadonlySet<string> = new Set([
  'hideCostsFromManagers', 'costsHidden', 'discountValue', 'discountValueMinor', 'redeemValueMinor', 'avgTransactionValue', 'avgTransactionValueMinor',
  'valueRemaining', 'useValue', 'defaultValue', 'value', 'costStore', 'expenses', 'expensesMinor', 'expensesByCategoryMinor',
  // internal names, never a response key
  'costMinorMetrics', '_costDecimal', 'GLOBAL_COST_KEYS', 'SCOPED_COST_KEYS', 'NOT_COST',
]);

export function costKeysFor(path: string): ReadonlySet<string> {
  const scoped = SCOPED_COST_KEYS.filter((s) => path.startsWith(s.prefix));
  if (!scoped.length) return GLOBAL_COST_KEYS;
  return new Set([...GLOBAL_COST_KEYS, ...scoped.flatMap((s) => [...s.keys])]);
}

/** Does the (plain, JSON-ready) value carry any of [keys] anywhere? Cheap pre-check before any database read. */
export function carriesCost(v: any, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(v)) return v.some((x) => carriesCost(x, keys));
  if (!v || typeof v !== 'object' || v instanceof Date) return false;
  for (const [k, x] of Object.entries(v)) if (keys.has(k) || carriesCost(x, keys)) return true;
  return false;
}

/** A copy of [v] without any of [keys] (at any depth). */
export function stripCost<T>(v: T, keys: ReadonlySet<string>): T {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object' || x instanceof Date) return x;
    const out: any = {};
    for (const [k, y] of Object.entries(x)) if (!keys.has(k)) out[k] = walk(y);
    return out;
  };
  return walk(JSON.parse(JSON.stringify(v)));
}
