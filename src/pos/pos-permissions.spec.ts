/* eslint-disable prettier/prettier */
import { APPROVAL_LIMITS, ActionContext, evaluate, LimitKey, POS_ACTIONS, POS_PERMISSIONS, POS_ROLES, PosAction, PosRole, resolveLimits } from './pos-permissions.config';

/**
 * The matrix is DATA, so the test is a table: for EVERY action × EVERY role, the expected outcome — allowed, denied, or needs approval (by whom) — below and
 * above each limit. A new action or a changed rule fails here until the table says what it should now do.
 */
const L = resolveLimits(null, 2); // USD defaults: money limits are in cents
const below = (a: PosAction): ActionContext => ({ qty: 1, valueMinor: 1, amountMinor: 1, points: 1 });
const above = (a: PosAction): ActionContext => {
  const c: ActionContext = {};
  for (const r of (POS_PERMISSIONS as any)[a].approval ?? []) if (r.ctx && r.limit) (c as any)[r.ctx] = L[r.limit as LimitKey] + 1;
  return c;
};
type Exp = 'allow' | 'deny' | 'manager' | 'owner';
const out = (a: PosAction, r: PosRole, ctx: ActionContext): Exp => {
  const d = evaluate(a, r, ctx, L);
  return d.decision === 'allow' ? 'allow' : d.decision === 'deny' ? 'deny' : d.approver;
};

// expected: [cashier, manager, owner] for a use BELOW the limits, and ABOVE them
const T: Record<PosAction, { below: [Exp, Exp, Exp]; above?: [Exp, Exp, Exp] }> = {
  'inventory.view':               { below: ['allow', 'allow', 'allow'] },
  'inventory.history.view':       { below: ['deny', 'allow', 'allow'] },
  'inventory.adjust':             { below: ['allow', 'allow', 'allow'], above: ['manager', 'allow', 'allow'] },
  'inventory.writeoff':           { below: ['deny', 'allow', 'allow'] },
  'inventory.count.start':        { below: ['deny', 'allow', 'allow'] },
  'inventory.count.enter':        { below: ['allow', 'allow', 'allow'] },
  'inventory.count.finish':       { below: ['deny', 'allow', 'allow'] },
  'inventory.transfer.create':    { below: ['deny', 'allow', 'allow'] },
  'inventory.transfer.receive':   { below: ['deny', 'allow', 'allow'] },
  'inventory.lot.sellExpired':    { below: ['deny', 'allow', 'allow'] }, // cashier: not in the role list; a manager is their own approver (audited)
  'catalog.edit':                 { below: ['deny', 'allow', 'allow'] },
  'customers.view':               { below: ['allow', 'allow', 'allow'] },
  'customers.create':             { below: ['allow', 'allow', 'allow'] },
  'customers.edit':               { below: ['deny', 'allow', 'allow'] },
  'storeCredit.spend':            { below: ['allow', 'allow', 'allow'] },
  'storeCredit.refundIssue':      { below: ['allow', 'allow', 'allow'], above: ['manager', 'allow', 'allow'] },
  'storeCredit.adjust':           { below: ['deny', 'allow', 'allow'], above: ['deny', 'owner', 'allow'] },
  'loyalty.redeem':               { below: ['allow', 'allow', 'allow'] },
  'loyalty.adjust':               { below: ['deny', 'allow', 'allow'], above: ['deny', 'owner', 'allow'] },
  'supply.view':                  { below: ['deny', 'allow', 'allow'] },
  'supply.po.write':              { below: ['deny', 'allow', 'allow'] },
  'supply.po.receive':            { below: ['deny', 'allow', 'allow'] },
  'supply.payment':               { below: ['deny', 'allow', 'allow'], above: ['deny', 'owner', 'allow'] },
  'cash.in':                      { below: ['allow', 'allow', 'allow'] },
  'cash.out':                     { below: ['allow', 'allow', 'allow'], above: ['manager', 'allow', 'allow'] },
  'expenses.record':              { below: ['allow', 'allow', 'allow'], above: ['manager', 'allow', 'allow'] },
  'expenses.approve':             { below: ['deny', 'allow', 'allow'] },
  'daybook.view':                 { below: ['deny', 'allow', 'allow'] },
  'team.attendance.own':          { below: ['allow', 'allow', 'allow'] },
  'team.attendance.edit':         { below: ['deny', 'allow', 'allow'] },
  'team.roster.edit':             { below: ['deny', 'allow', 'allow'] },
  'settings.approvalLimits.view': { below: ['deny', 'allow', 'allow'] },
  'settings.approvalLimits.edit': { below: ['deny', 'deny', 'allow'] },
};

describe('the permission matrix: every action × every role', () => {
  it('the table covers EVERY action in the matrix (a new action without a row fails here)', () => {
    expect(Object.keys(T).sort()).toEqual([...POS_ACTIONS].sort());
  });

  for (const action of POS_ACTIONS) {
    POS_ROLES.forEach((role, i) => {
      it(`${action} · ${role}: below the limits → ${T[action].below[i]}`, () => {
        expect(out(action, role, below(action))).toBe(T[action].below[i]);
      });
      if (T[action].above) {
        it(`${action} · ${role}: above the limits → ${T[action].above![i]}`, () => {
          expect(out(action, role, above(action))).toBe(T[action].above![i]);
        });
      }
    });
  }

  it('an action that needs approval ALWAYS (an expired lot) is allowed for a manager acting as their own approver, denied for a cashier', () => {
    expect(out('inventory.lot.sellExpired', 'cashier', {})).toBe('deny');
    expect(out('inventory.lot.sellExpired', 'manager', {})).toBe('allow');
  });

  it('exactly AT the limit is allowed; one above needs approval (the limit is inclusive)', () => {
    expect(out('cash.out', 'cashier', { amountMinor: L.cashOutMinor })).toBe('allow');
    expect(out('cash.out', 'cashier', { amountMinor: L.cashOutMinor + 1 })).toBe('manager');
    expect(out('inventory.adjust', 'cashier', { qty: L.stockAdjustQty })).toBe('allow');
    expect(out('inventory.adjust', 'cashier', { qty: L.stockAdjustQty + 1 })).toBe('manager');
    // value is checked independently of quantity
    expect(out('inventory.adjust', 'cashier', { qty: 1, valueMinor: L.stockAdjustValueMinor + 1 })).toBe('manager');
  });

  it('no role, an unknown action or a missing role is denied — never allowed by default', () => {
    expect(evaluate('inventory.view', null, {}, L)).toEqual({ decision: 'deny', reason: 'role_not_allowed' });
    expect(evaluate('nope.nothing', 'owner', {}, L)).toEqual({ decision: 'deny', reason: 'unknown_action' });
  });
});

describe('limits (D6): per-store overrides over documented defaults', () => {
  it('defaults are major units scaled by the currency exponent (USD ×100, JPY ×1, KWD ×1000); counts are not scaled', () => {
    expect(resolveLimits(null, 2).cashOutMinor).toBe(10_000);
    expect(resolveLimits(null, 0).cashOutMinor).toBe(100);
    expect(resolveLimits(null, 3).cashOutMinor).toBe(100_000);
    expect(resolveLimits(null, 2).stockAdjustQty).toBe(5);
  });
  it('a store override (minor units) wins; junk (negative, NaN, strings) is ignored and falls back to the default', () => {
    const l = resolveLimits({ cashOutMinor: 25_000, expenseMinor: -1 as any, stockAdjustQty: 'x' as any }, 2);
    expect([l.cashOutMinor, l.expenseMinor, l.stockAdjustQty]).toEqual([25_000, 10_000, 5]);
    // and an override moves the decision
    expect(out('cash.out', 'cashier', { amountMinor: 20_000 })).toBe('manager'); // default 10 000
    expect(evaluate('cash.out', 'cashier', { amountMinor: 20_000 }, l)).toEqual({ decision: 'allow' });
  });
  it('every limit key has a default and a label (the documentation table is generated from it)', () => {
    for (const [k, d] of Object.entries(APPROVAL_LIMITS)) expect([k, typeof d.default, d.label.length > 0]).toEqual([k, 'number', true]);
  });
});
