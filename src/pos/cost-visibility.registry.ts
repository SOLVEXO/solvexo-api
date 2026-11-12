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
  // caught by the source scan when the registry was built; classified in G4.9 — see COST_FIELD_DECISIONS below for the trace and the reason
  'shippingCostMinor', 'taxCostMinor', 'itemUnitCostMinor',
  // payables in a report (the profit report's note on supplier payments) — found on the screenshot pass
  'supplierPaymentsMinor', 'supplierPayments', 'supplierPaymentsNote',
  // G5.1: the last unit cost a supplier charged (supplier detail → productsSupplied) — cost everywhere
  'lastUnitCostMinor', 'lastUnitCost',
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

/**
 * G4.9 — the three fields the G4.8 scan caught, traced to every write and read, and classified. Each has ONE meaning (none is used for both an
 * inbound and a customer amount, so nothing was renamed). The customer-charged amounts have other names and stay visible: a sale's `taxMinor` /
 * line tax and an order's shipping are not in GLOBAL_COST_KEYS (`taxMinor` / `shippingMinor` are cost only under /api/pos/supply/, as PO amounts).
 */
export const COST_FIELD_DECISIONS: Readonly<Record<string, { classified: 'cost' | 'visible'; reason: string }>> = {
  itemUnitCostMinor: {
    classified: 'cost',
    reason: 'purchase-order line unit cost: purchaseOrderTwins() (common/cost-minor.util) derives it from items[].unitCost; the PO pre-validate hook writes it to items[].unitCostMinor. Never a customer price.',
  },
  shippingCostMinor: {
    classified: 'cost',
    reason: 'inbound: the shipping the SUPPLIER charges on a purchase order (CreatePurchaseOrderDto.shippingCost → PurchaseOrder.shippingCost + twin; part of the PO total and landed cost; read by pos-supply as the PO shippingMinor; printed on the PO PDF). Only on purchase orders.',
  },
  taxCostMinor: {
    classified: 'cost',
    reason: 'inbound: the tax on a purchase order / supplier bill (CreatePurchaseOrderDto.taxCost → PurchaseOrder.taxCost + twin; part of the PO total; read by pos-supply as the PO taxMinor). The tax charged to the CUSTOMER is the sale\'s taxMinor, a different field.',
  },
};

/** Cost-looking names that are NOT cost (settings, sale values, discounts, loyalty) — the scan test accepts these. */
export const NOT_COST: ReadonlySet<string> = new Set([
  'hideCostsFromManagers', 'costsHidden', 'discountValue', 'discountValueMinor', 'redeemValueMinor', 'avgTransactionValue', 'avgTransactionValueMinor',
  'valueRemaining', 'useValue', 'defaultValue', 'value', 'costStore', 'expenses', 'expensesMinor', 'expensesByCategoryMinor',
  // internal names, never a response key
  'costMinorMetrics', '_costDecimal', 'GLOBAL_COST_KEYS', 'SCOPED_COST_KEYS', 'NOT_COST', 'COST_FIELD_DECISIONS',
]);

/** Which keys are cost on [path]: the global ones, plus the route's scoped keys and pattern. */
export type CostMatcher = (key: string) => boolean;
export function costKeysFor(path: string): CostMatcher {
  const scoped = SCOPED_COST_KEYS.filter((s) => path.startsWith(s.prefix));
  return (k) => GLOBAL_COST_KEYS.has(k) || scoped.some((s) => s.keys.has(k) || (s.pattern?.test(k) ?? false));
}
const asMatcher = (m: CostMatcher | ReadonlySet<string>): CostMatcher => (typeof m === 'function' ? m : (k) => m.has(k));

/**
 * Does the value carry a cost key anywhere? Cheap pre-check before any database read. Walks what the response will SERIALIZE to: a Mongoose document,
 * an ObjectId … are taken through their own `toJSON()` (as Nest's JSON serialization does), and a cycle is never followed — a hydrated document returned
 * by a handler (e.g. the created sale) is full of internal back-references.
 */
export function carriesCost(v: any, keys: CostMatcher | ReadonlySet<string>): boolean {
  const is = asMatcher(keys);
  const seen = new WeakSet<object>();
  const walk = (x: any): boolean => {
    if (!x || typeof x !== 'object' || x instanceof Date) return false;
    if (typeof x.toJSON === 'function') {
      const j = x.toJSON();
      if (j !== x) return walk(j);
    }
    if (seen.has(x)) return false;
    seen.add(x);
    if (Array.isArray(x)) return x.some(walk);
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
