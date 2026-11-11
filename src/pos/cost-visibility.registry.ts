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

/** Route-scoped: [path prefix (after the host), keys that are cost on those routes only, and optionally a key PATTERN that is cost there]. */
export const SCOPED_COST_KEYS: ReadonlyArray<{ prefix: string; keys: ReadonlySet<string>; pattern?: RegExp }> = [
  // inventory: `value` / `valueMinor` = quantity × cost (stock rows, lots, movements)
  { prefix: '/api/pos/inventory/', keys: new Set(['value', 'valueMinor']) },
  // supply: purchase orders, receipts, supplier returns, payables and the supplier ledger — every amount there is a cost or a payable
  {
    prefix: '/api/pos/supply/',
    // every minor-unit amount under supply (incl. the payables aging buckets d30Minor / d60Minor / d90Minor) — a pattern, so a new amount cannot leak
    pattern: /Minor$/,
    keys: new Set([
      'amount', 'amountMinor', 'balance', 'balanceMinor', 'balanceAfter', 'balanceAfterMinor', 'total', 'totalMinor', 'subtotal', 'subtotalMinor',
      'lineTotal', 'lineTotalMinor', 'tax', 'taxMinor', 'shipping', 'shippingMinor', 'credit', 'creditMinor', 'current', 'currentMinor',
      'unit', 'unitMinor', 'prev', 'prevMinor', 'new', 'newMinor', 'paid', 'paidMinor', 'outstanding', 'outstandingMinor', 'overdueMinor',
      'dueMinor', 'aging', 'agingMinor', 'payable', 'payableMinor', 'payables', 'd30', 'd60', 'd90',
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

/** Which keys are cost on [path]: the global ones, plus the route's scoped keys and pattern. */
export type CostMatcher = (key: string) => boolean;
export function costKeysFor(path: string): CostMatcher {
  const scoped = SCOPED_COST_KEYS.filter((s) => path.startsWith(s.prefix));
  return (k) => GLOBAL_COST_KEYS.has(k) || scoped.some((s) => s.keys.has(k) || (s.pattern?.test(k) ?? false));
}
const asMatcher = (m: CostMatcher | ReadonlySet<string>): CostMatcher => (typeof m === 'function' ? m : (k) => m.has(k));

/** Does the (plain, JSON-ready) value carry a cost key anywhere? Cheap pre-check before any database read. */
export function carriesCost(v: any, keys: CostMatcher | ReadonlySet<string>): boolean {
  const is = asMatcher(keys);
  const walk = (x: any): boolean => {
    if (Array.isArray(x)) return x.some(walk);
    if (!x || typeof x !== 'object' || x instanceof Date) return false;
    for (const [k, y] of Object.entries(x)) if (is(k) || walk(y)) return true;
    return false;
  };
  return walk(v);
}

/** A copy of [v] without any cost key (at any depth). */
export function stripCost<T>(v: T, keys: CostMatcher | ReadonlySet<string>): T {
  const is = asMatcher(keys);
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object' || x instanceof Date) return x;
    const out: any = {};
    for (const [k, y] of Object.entries(x)) if (!is(k)) out[k] = walk(y);
    return out;
  };
  return walk(JSON.parse(JSON.stringify(v)));
}
