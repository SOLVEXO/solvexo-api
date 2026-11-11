/* eslint-disable prettier/prettier */
/**
 * THE permission matrix of the till (G3.0, decisions D1 + D6): ONE table — action → allowed roles → approval rule — and nothing else decides who may do what.
 * Routes do not contain role checks; they name an action and ask `PosAuthorizer`. Making this editable per store later (G4) means changing where THIS data
 * comes from (a per-store override document), not touching a route.
 *
 * Roles (fixed for G3): `cashier`, `manager` (both are PIN sessions of an employee) and `owner` (the owner's own login — a non-device JWT, i.e. the owner session).
 * Ranks: cashier < manager < owner. A role may always do what a lower role may, only if the action lists it (the table says so explicitly, no implicit inheritance).
 *
 * Approval (D6): an allowed role can still need a HIGHER role to approve this particular use — when a measured value is ABOVE the store's limit (or always).
 * The approver is a manager's PIN (header `x-pos-approver-token`) or, for `owner`, the owner session. A manager acting alone above an `owner` limit is refused.
 * Every approval is audit-logged with who asked and who approved.
 */
export const POS_ROLES = ['cashier', 'manager', 'owner'] as const;
export type PosRole = (typeof POS_ROLES)[number];
export const roleRank = (r: PosRole): number => POS_ROLES.indexOf(r);

/** What a limit measures. `qty` = units (or points), `minor` = money in the STORE currency's minor units. */
export interface LimitDef { kind: 'qty' | 'minor'; /** the default: units for `qty`, MAJOR units of the currency for `minor` (scaled by the currency exponent when resolved) */ default: number; label: string }
export const APPROVAL_LIMITS = {
  stockAdjustQty:            { kind: 'qty',   default: 5,    label: 'Stock adjustment a cashier may make alone — units' },
  stockAdjustValueMinor:     { kind: 'minor', default: 20,   label: 'Stock adjustment a cashier may make alone — value at cost' },
  cashOutMinor:              { kind: 'minor', default: 100,  label: 'Cash out / safe drop' },
  expenseMinor:              { kind: 'minor', default: 100,  label: 'Expense' },
  purchaseOrderMinor:        { kind: 'minor', default: 1000, label: 'Purchase order a manager may approve alone' },
  supplierPaymentManagerMinor: { kind: 'minor', default: 500,  label: 'Supplier payment a manager may make alone' },
  supplierPaymentOwnerMinor:   { kind: 'minor', default: 2000, label: 'Supplier payment that needs the owner' },
  storeCreditRefundMinor:    { kind: 'minor', default: 50,   label: 'Refund to store credit' },
  storeCreditAdjustMinor:    { kind: 'minor', default: 100,  label: 'Manual store-credit adjustment' },
  loyaltyAdjustPoints:       { kind: 'qty',   default: 500,  label: 'Manual loyalty points adjustment' },
} as const satisfies Record<string, LimitDef>;
export type LimitKey = keyof typeof APPROVAL_LIMITS;

export type Metric = 'qty' | 'minor';
export interface ApprovalRule {
  /** the limit that triggers it; omitted + `always` = every use needs approval */
  limit?: LimitKey;
  /** which value of the request is compared: ctx.qty / ctx.valueMinor / ctx.amountMinor … (the name in the context) */
  ctx?: 'qty' | 'valueMinor' | 'amountMinor' | 'points';
  always?: boolean;
  /** who has to approve */
  approver: 'manager' | 'owner';
}
export interface PermissionRule { label: string; roles: readonly PosRole[]; approval?: readonly ApprovalRule[] }

const ALL = ['cashier', 'manager', 'owner'] as const;
const MGR = ['manager', 'owner'] as const;
const OWN = ['owner'] as const;

export const POS_PERMISSIONS = {
  // ── inventory (G3.1)
  'inventory.view':            { label: 'See stock, lots and low stock', roles: ALL },
  'inventory.history.view':    { label: 'See stock movement history', roles: MGR },
  'inventory.adjust':          { label: 'Adjust stock (a cashier only a little, a manager PIN above the limits)', roles: ALL, approval: [{ limit: 'stockAdjustQty', ctx: 'qty', approver: 'manager' }, { limit: 'stockAdjustValueMinor', ctx: 'valueMinor', approver: 'manager' }] },
  'inventory.writeoff':        { label: 'Write off damaged / expired stock', roles: MGR },
  'inventory.count.start':     { label: 'Start a stock count', roles: MGR },
  'inventory.count.enter':     { label: 'Enter counted quantities', roles: ALL },
  'inventory.count.finish':    { label: 'Finish a count and post its variances', roles: MGR },
  'inventory.transfer.create': { label: 'Create / ship a stock transfer', roles: MGR },
  'inventory.transfer.receive':{ label: 'Receive a stock transfer', roles: MGR },
  'inventory.lot.sellExpired': { label: 'Sell stock from an expired lot (override)', roles: ALL, approval: [{ always: true, approver: 'manager' }] },
  'catalog.create':            { label: 'Create products and variants from the till', roles: MGR },
  'catalog.categories.edit':   { label: 'Create / rename / delete categories', roles: MGR },
  'catalog.import':            { label: 'Import products or categories from a CSV file', roles: MGR },
  'catalog.modifiers.edit':    { label: 'Edit modifier groups (sizes, extras …)', roles: MGR },
  'catalog.pricebooks.edit':   { label: 'Edit price books and assign them to customers', roles: MGR },
  // G4.8: everyone may reprint; when the store requires a PIN to reprint, a cashier's reprint needs a manager (the reprint service applies the setting)
  'sales.reprint':             { label: 'Reprint a receipt, invoice or credit note', roles: ALL },
  'catalog.edit':              { label: 'Edit price, barcode, category, HS code', roles: MGR },
  // ── customers / credit / loyalty (G3.3)
  'customers.view':            { label: 'Find customers and see their balance', roles: ALL },
  'customers.create':          { label: 'Add a customer', roles: ALL },
  'customers.edit':            { label: 'Edit customer details and tax ID', roles: MGR },
  'storeCredit.spend':         { label: 'Pay with store credit', roles: ALL },
  'storeCredit.refundIssue':   { label: 'Refund to store credit', roles: ALL, approval: [{ limit: 'storeCreditRefundMinor', ctx: 'amountMinor', approver: 'manager' }] },
  'storeCredit.adjust':        { label: 'Adjust a customer\'s store credit by hand', roles: MGR, approval: [{ limit: 'storeCreditAdjustMinor', ctx: 'amountMinor', approver: 'owner' }] },
  'loyalty.redeem':            { label: 'Redeem loyalty points at checkout', roles: ALL },
  'loyalty.configure':         { label: 'Set the loyalty earn / redeem rates for the till', roles: OWN },
  'loyalty.adjust':            { label: 'Adjust loyalty points by hand', roles: MGR, approval: [{ limit: 'loyaltyAdjustPoints', ctx: 'points', approver: 'owner' }] },
  // ── supply (G3.4)
  'supply.view':               { label: 'See suppliers and purchase orders', roles: MGR },
  'supply.po.write':           { label: 'Create / edit a purchase order', roles: MGR },
  'supply.po.approve':         { label: 'Approve a purchase order (above the limit the owner approves)', roles: MGR, approval: [{ limit: 'purchaseOrderMinor', ctx: 'amountMinor', approver: 'owner' }] },
  'supply.po.receive':         { label: 'Receive stock against an approved purchase order', roles: ALL },
  'supply.receive.direct':     { label: 'Receive stock without a purchase order', roles: MGR },
  'supply.return':             { label: 'Return stock to a supplier', roles: MGR },
  'supply.costs.view':         { label: 'See costs, payables and payments', roles: MGR },
  'supply.payment':            { label: 'Pay a supplier', roles: MGR, approval: [{ limit: 'supplierPaymentManagerMinor', ctx: 'amountMinor', approver: 'owner' }] },
  // ── cash (G3.5)
  'cash.in':                   { label: 'Cash in (float top-up)', roles: ALL },
  'cash.out':                  { label: 'Cash out / safe drop', roles: ALL, approval: [{ limit: 'cashOutMinor', ctx: 'amountMinor', approver: 'manager' }] },
  'expenses.record':           { label: 'Record an expense', roles: ALL, approval: [{ limit: 'expenseMinor', ctx: 'amountMinor', approver: 'manager' }] },
  'expenses.approve':          { label: 'Approve / reject an expense', roles: MGR },
  'daybook.view':              { label: 'See the daybook (a cashier only the shifts they worked)', roles: ALL },
  // ── team (G3.6)
  'team.attendance.own':       { label: 'Clock in / out', roles: ALL },
  'team.attendance.view':      { label: 'See everyone\'s attendance, anomalies and reports', roles: MGR },
  'team.roster.view':          { label: 'See the shift roster', roles: ALL },
  'team.attendance.edit':      { label: 'Edit someone\'s attendance', roles: MGR },
  'team.roster.edit':          { label: 'Edit the shift roster', roles: MGR },
  // ── reports (G4.1)
  'reports.view':              { label: 'See the business reports (sales, profit, products, tax, payments, hours)', roles: MGR },
  'reports.cashier.own':       { label: 'See the cashier report (a cashier only their own figures)', roles: ALL },
  // ── store settings (G4.0)
  'settings.store.edit':       { label: 'Change the store settings (time zone …)', roles: OWN },
  // ── settings
  'audit.verify':                { label: 'Check that sealed audit records were not changed', roles: MGR },
  'settings.permissions.view':   { label: 'See who may do what (the permission matrix)', roles: MGR },
  'settings.permissions.edit':   { label: 'Change who may do what (owner only, always)', roles: OWN },
  'settings.approvalLimits.view': { label: 'See the approval limits', roles: MGR },
  'settings.approvalLimits.edit': { label: 'Change the approval limits', roles: OWN },
} as const satisfies Record<string, PermissionRule>;
export type PosAction = keyof typeof POS_PERMISSIONS;
export const POS_ACTIONS = Object.keys(POS_PERMISSIONS) as PosAction[];

/** What a request measures. Only the fields the action's rules name are read. */
export interface ActionContext { qty?: number; valueMinor?: number; amountMinor?: number; points?: number }
export type ResolvedLimits = Record<LimitKey, number>;

/** The store's effective limits: its own overrides (minor units / counts) over the documented defaults (major units × 10^exponent). */
export function resolveLimits(overrides: Partial<Record<LimitKey, number>> | null | undefined, exponent: number): ResolvedLimits {
  const out = {} as ResolvedLimits;
  for (const k of Object.keys(APPROVAL_LIMITS) as LimitKey[]) {
    const def = APPROVAL_LIMITS[k] as LimitDef;
    const own = overrides?.[k];
    out[k] = typeof own === 'number' && Number.isFinite(own) && own >= 0 ? own : def.kind === 'minor' ? Math.round(def.default * 10 ** exponent) : def.default;
  }
  return out;
}

export type Decision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'role_not_allowed' | 'unknown_action' }
  | { decision: 'needs_approval'; approver: 'manager' | 'owner'; reasons: string[] };

/** PURE: may [role] do [action] with [ctx] under [limits]? */
export function evaluate(action: string, role: PosRole | null | undefined, ctx: ActionContext, limits: ResolvedLimits, rules: Record<string, PermissionRule> = POS_PERMISSIONS as Record<string, PermissionRule>): Decision {
  const rule = rules[action];
  if (!rule) return { decision: 'deny', reason: 'unknown_action' };
  if (!role || !rule.roles.includes(role)) return { decision: 'deny', reason: 'role_not_allowed' };
  const reasons: string[] = [];
  let needed: 'manager' | 'owner' | null = null;
  for (const a of rule.approval ?? []) {
    const exceeded = a.always ? true : a.limit && a.ctx ? (ctx[a.ctx] ?? 0) > limits[a.limit] : false;
    if (!exceeded) continue;
    if (roleRank(role) >= roleRank(a.approver)) continue; // the actor IS the approver for this rule
    reasons.push(a.always ? 'always' : String(a.limit));
    if (!needed || roleRank(a.approver) > roleRank(needed)) needed = a.approver;
  }
  return needed ? { decision: 'needs_approval', approver: needed, reasons } : { decision: 'allow' };
}

// ── G4.2: the matrix becomes editable per store (owner only) ──────────────────────────────────────────────────────────────────────────
/**
 * A store's override of one action: which roles may do it, and per DEFAULT approval rule (same order) whether it is on and who approves.
 * Overrides never add new approval rules or new limits — the documented rules are the menu, the owner picks from it.
 */
export interface RuleOverride { roles?: PosRole[]; approval?: Array<{ enabled?: boolean; approver?: 'manager' | 'owner' }> }
export type PermissionOverrides = Partial<Record<PosAction, RuleOverride>>;
/** Never editable: who may change the permissions (and see them) — so nobody can lock the owner out or grant themself the editor. */
export const PINNED_ACTIONS: readonly PosAction[] = ['settings.permissions.edit', 'settings.permissions.view'];

/** The effective rule of [action] for a store with [overrides] (the documented default when there is none). PURE. */
export function effectiveRule(action: PosAction, ov: RuleOverride | undefined): PermissionRule {
  const base = (POS_PERMISSIONS as Record<string, PermissionRule>)[action];
  if (!ov || PINNED_ACTIONS.includes(action)) return base;
  const roles = ov.roles ? POS_ROLES.filter((r) => r === 'owner' || ov.roles!.includes(r)) : base.roles; // the owner can never be removed
  const approval = (base.approval ?? []).flatMap((rule, i) => {
    const o = ov.approval?.[i];
    if (o?.enabled === false) return [];
    return [{ ...rule, approver: o?.approver ?? rule.approver }];
  });
  return { label: base.label, roles, approval };
}
export function effectiveTable(overrides: PermissionOverrides | null | undefined): Record<string, PermissionRule> {
  const out: Record<string, PermissionRule> = {};
  for (const a of POS_ACTIONS) out[a] = effectiveRule(a, overrides?.[a]);
  return out;
}
/** What is wrong with a proposed override set (empty = fine). */
export function overrideErrors(overrides: Record<string, any>): string[] {
  const errs: string[] = [];
  for (const [action, ov] of Object.entries(overrides ?? {})) {
    const base = (POS_PERMISSIONS as Record<string, PermissionRule>)[action];
    if (!base) { errs.push(`${action}: unknown action`); continue; }
    if (PINNED_ACTIONS.includes(action as PosAction)) { errs.push(`${action}: cannot be changed (pinned)`); continue; }
    if (ov == null || typeof ov !== 'object') { errs.push(`${action}: invalid`); continue; }
    if (ov.roles !== undefined) {
      if (!Array.isArray(ov.roles) || ov.roles.some((r: any) => !(POS_ROLES as readonly string[]).includes(r))) errs.push(`${action}: roles must be cashier / manager / owner`);
      else if (!ov.roles.includes('owner')) errs.push(`${action}: the owner can always do everything`);
    }
    if (ov.approval !== undefined) {
      if (!Array.isArray(ov.approval) || ov.approval.length > (base.approval ?? []).length) errs.push(`${action}: approval must follow the default rules (${(base.approval ?? []).length})`);
      else ov.approval.forEach((a: any, i: number) => {
        if (a == null || typeof a !== 'object') errs.push(`${action}: approval ${i} invalid`);
        else if (a.approver !== undefined && a.approver !== 'manager' && a.approver !== 'owner') errs.push(`${action}: approval ${i} approver must be manager or owner`);
        else if (a.enabled !== undefined && typeof a.enabled !== 'boolean') errs.push(`${action}: approval ${i} enabled must be true / false`);
      });
    }
  }
  return errs;
}
/** Drops everything equal to the default, so "no override" and "an override that says the default" are the same thing (and reset = {}). */
export function normalizeOverrides(overrides: Record<string, any>): PermissionOverrides {
  const out: PermissionOverrides = {};
  for (const [action, ov] of Object.entries(overrides ?? {})) {
    const base = (POS_PERMISSIONS as Record<string, PermissionRule>)[action];
    if (!base || PINNED_ACTIONS.includes(action as PosAction)) continue;
    const eff = effectiveRule(action as PosAction, ov);
    const sameRoles = [...eff.roles].sort().join() === [...base.roles].sort().join();
    const sameApproval = JSON.stringify(eff.approval ?? []) === JSON.stringify(base.approval ?? []);
    if (sameRoles && sameApproval) continue;
    out[action as PosAction] = { ...(sameRoles ? {} : { roles: [...eff.roles] }), ...(sameApproval ? {} : { approval: (base.approval ?? []).map((rule, i) => ({ enabled: (ov.approval?.[i]?.enabled ?? true) !== false, approver: ov.approval?.[i]?.approver ?? rule.approver })) }) };
  }
  return out;
}
