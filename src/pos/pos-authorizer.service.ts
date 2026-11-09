/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { isoExponent } from '@/common/money-minor.util';
import { PosService } from './pos.service';
import { ActionContext, Decision, evaluate, PosAction, PosRole, POS_PERMISSIONS, ResolvedLimits, resolveLimits, roleRank } from './pos-permissions.config';

export interface AuthorizedActor {
  role: PosRole;
  /** the employee of the PIN session; null for the owner's own login */
  employeeId: string | null;
  /** who approved this particular use (manager PIN), if it needed one */
  approvedBy: { employeeId: string; role: PosRole } | null;
  decision: Decision;
}

/**
 * The ONE place a till-facing route asks "may this caller do this?" — it reads the matrix (`pos-permissions.config.ts`), never a role in the route.
 *  - WHO: a device token needs a verified PIN session (cashier / manager); the owner's own login (a non-device JWT) is the `owner`. A web staff JWT is none of the POS roles.
 *  - WHAT: the action's rule + the store's approval limits (D6; per store, documented defaults).
 *  - APPROVAL: a manager's PIN in `x-pos-approver-token` (verified server-side, same store, role ≥ manager); an `owner` approval can only come from the owner's own login.
 *  - AUDIT: every denial and every approval is written (awaited) with who / what / why.
 */
@Injectable()
export class PosAuthorizer {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService) {}
  private get r() { return this.db.repositories; }

  async limitsFor(storeId: string): Promise<ResolvedLimits> {
    const [settings, store]: any[] = await Promise.all([
      this.r.posSettingsModel.findOne({ storeId }).select('approvalLimits').lean(),
      this.r.storeModel.findById(storeId).select('baseCurrency').lean(),
    ]);
    return resolveLimits(settings?.approvalLimits ?? null, isoExponent(store?.baseCurrency));
  }

  /** The caller's POS role (null = none: staff JWT, no PIN session…). */
  async roleOf(req: any, storeId: string, employeeToken?: string): Promise<{ role: PosRole | null; employeeId: string | null }> {
    if (req?.user?.posDevice) {
      const emp = await this.pos.verifyEmployeeToken(employeeToken, storeId);
      if (!emp) return { role: null, employeeId: null };
      return { role: emp.role === 'manager' ? 'manager' : emp.role === 'cashier' ? 'cashier' : null, employeeId: emp.employeeId };
    }
    return req?.user?.role === 'seller' ? { role: 'owner', employeeId: null } : { role: null, employeeId: null };
  }

  private async audit(storeId: string, employeeId: string | null, action: string, targetId: string | null, metadata: object) {
    try {
      await this.r.posAuditLogModel.create([{ storeId, employeeId, action, targetId, targetType: 'permission', metadata, deviceId: (this.pos as any).callerDeviceId?.() ?? null }]);
    } catch { /* an audit failure must not turn a denial into a 500 */ }
  }

  /** Throws a 403 with a machine code, or returns who acted and who (if anyone) approved. */
  async authorize(req: any, a: { storeId: string; action: PosAction; ctx?: ActionContext; employeeToken?: string; approverToken?: string }): Promise<AuthorizedActor> {
    const who = await this.roleOf(req, a.storeId, a.employeeToken);
    const limits = await this.limitsFor(a.storeId);
    const decision = evaluate(a.action, who.role, a.ctx ?? {}, limits);
    const label = (POS_PERMISSIONS as any)[a.action]?.label ?? a.action;

    if (decision.decision === 'deny') {
      const needsPin = req?.user?.posDevice && !who.role;
      await this.audit(a.storeId, who.employeeId, 'pos_action_denied', null, { action: a.action, role: who.role, reason: decision.reason });
      throw new ForbiddenException(needsPin
        ? { statusCode: 403, code: 'POS_PIN_REQUIRED', message: 'A valid PIN session is required for this' }
        : { statusCode: 403, code: 'POS_ACTION_FORBIDDEN', action: a.action, message: `Your role cannot ${label.toLowerCase()}` });
    }
    if (decision.decision === 'allow') return { role: who.role!, employeeId: who.employeeId, approvedBy: null, decision };

    // needs approval
    if (decision.approver === 'owner') {
      await this.audit(a.storeId, who.employeeId, 'pos_approval_missing', null, { action: a.action, role: who.role, approver: 'owner', reasons: decision.reasons });
      throw new ForbiddenException({ statusCode: 403, code: 'POS_OWNER_REQUIRED', action: a.action, reasons: decision.reasons, message: 'The owner must approve this — sign in as the owner' });
    }
    const approver = await this.pos.verifyEmployeeToken(a.approverToken, a.storeId);
    if (!approver || roleRank(approver.role as PosRole) < roleRank('manager')) {
      await this.audit(a.storeId, who.employeeId, 'pos_approval_missing', null, { action: a.action, role: who.role, approver: 'manager', reasons: decision.reasons });
      throw new ForbiddenException({ statusCode: 403, code: 'POS_APPROVAL_REQUIRED', action: a.action, approver: 'manager', reasons: decision.reasons, message: 'A manager must approve this' });
    }
    await this.audit(a.storeId, approver.employeeId, 'pos_approval_given', null, { action: a.action, requestedBy: who.employeeId, role: who.role, reasons: decision.reasons, ctx: a.ctx ?? {} });
    return { role: who.role!, employeeId: who.employeeId, approvedBy: { employeeId: approver.employeeId, role: 'manager' }, decision };
  }
}
