/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { APPROVAL_LIMITS, effectiveRule, normalizeOverrides, overrideErrors, PermissionOverrides, PermissionRule, PINNED_ACTIONS, PosAction, POS_ACTIONS, POS_PERMISSIONS } from './pos-permissions.config';

type Req = any;
interface Tokens { employee?: string }

/**
 * G4.2 — the permission matrix, editable per store by the OWNER (decision 6): the three fixed roles, safe defaults (the documented table), pinned actions
 * (who may edit / see permissions) never change, the owner can never be removed from anything, "reset to defaults", every change audited with a before / after diff,
 * optimistic versioning so two owners' devices cannot overwrite each other. The authorizer reads the effective table on every check.
 */
@Injectable()
export class PosPermissionsStoreService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}
  private get r(): any { return this.db.repositories; }

  private view(action: PosAction, ov: any) {
    const base = (POS_PERMISSIONS as Record<string, PermissionRule>)[action];
    const eff = effectiveRule(action, ov);
    return {
      action, label: base.label, pinned: PINNED_ACTIONS.includes(action), changed: !!ov,
      defaultRoles: [...base.roles], roles: [...eff.roles],
      approval: (base.approval ?? []).map((rule, i) => ({ limit: rule.limit ?? null, limitLabel: rule.limit ? (APPROVAL_LIMITS as any)[rule.limit]?.label ?? null : null, measures: rule.ctx ?? null, always: !!rule.always, defaultApprover: rule.approver, approver: ov?.approval?.[i]?.approver ?? rule.approver, enabled: ov?.approval?.[i]?.enabled !== false })),
    };
  }
  private async load(storeId: string) {
    await this.r.posSettingsModel.updateOne({ storeId }, { $setOnInsert: { storeId } }, { upsert: true });
    const s: any = await this.r.posSettingsModel.findOne({ storeId }).select('permissionOverrides permissionsVersion').lean();
    return { overrides: (s?.permissionOverrides ?? {}) as PermissionOverrides, version: s?.permissionsVersion ?? 0 };
  }
  private diff(before: PermissionOverrides, after: PermissionOverrides) {
    const out: any[] = [];
    for (const a of POS_ACTIONS) {
      const b = effectiveRule(a, before[a]); const c = effectiveRule(a, after[a]);
      if ([...b.roles].sort().join() !== [...c.roles].sort().join()) out.push({ action: a, field: 'roles', before: b.roles, after: c.roles });
      if (JSON.stringify(b.approval ?? []) !== JSON.stringify(c.approval ?? [])) out.push({ action: a, field: 'approval', before: b.approval ?? [], after: c.approval ?? [] });
    }
    return out;
  }

  async get(req: Req, storeId: string, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'settings.permissions.view', employeeToken: t.employee });
    const { overrides, version } = await this.load(storeId);
    return { success: true, data: { version, canEdit: a.role === 'owner', roles: ['cashier', 'manager', 'owner'], actions: POS_ACTIONS.map((x) => this.view(x, (overrides as any)[x])) } };
  }

  /** `changes` = { action: { roles?, approval? } } merged over the current overrides; `preview: true` only returns the diff. `expectedVersion` guards against a stale screen. */
  async update(req: Req, storeId: string, body: any, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'settings.permissions.edit', employeeToken: t.employee });
    const changes = body?.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new BadRequestException({ statusCode: 400, code: 'CHANGES_REQUIRED', message: 'Send the changes as { action: { roles, approval } }' });
    const errors = overrideErrors(changes);
    if (errors.length) throw new BadRequestException({ statusCode: 400, code: 'INVALID_PERMISSIONS', message: errors[0], errors });
    const cur = await this.load(storeId);
    const next = normalizeOverrides({ ...cur.overrides, ...changes });
    const diff = this.diff(cur.overrides, next);
    if (body?.preview === true) return { success: true, data: { preview: true, version: cur.version, diff } };
    if (!diff.length) return { ...(await this.get(req, storeId, t)), unchanged: true };
    const expected = body?.expectedVersion ?? cur.version;
    const hit = await this.r.posSettingsModel.findOneAndUpdate({ storeId, permissionsVersion: expected === 0 ? { $in: [0, null] } : expected }, { $set: { permissionOverrides: next }, $inc: { permissionsVersion: 1 } }, { new: true });
    if (!hit) throw new ConflictException({ statusCode: 409, code: 'VERSION_CONFLICT', message: 'The permissions were changed on another device — reload and try again.' });
    await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: 'permissions_changed', targetId: storeId, targetType: 'permission', metadata: { version: hit.permissionsVersion, diff } }]);
    return this.get(req, storeId, t);
  }

  async reset(req: Req, storeId: string, body: any, t: Tokens) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const a = await this.auth.authorize(req, { storeId, action: 'settings.permissions.edit', employeeToken: t.employee });
    const cur = await this.load(storeId);
    const diff = this.diff(cur.overrides, {});
    if (body?.preview === true) return { success: true, data: { preview: true, version: cur.version, diff } };
    await this.r.posSettingsModel.updateOne({ storeId }, { $set: { permissionOverrides: {} }, $inc: { permissionsVersion: 1 } });
    await this.r.posAuditLogModel.create([{ storeId, employeeId: a.employeeId, action: 'permissions_reset', targetId: storeId, targetType: 'permission', metadata: { diff } }]);
    return this.get(req, storeId, t);
  }
}
