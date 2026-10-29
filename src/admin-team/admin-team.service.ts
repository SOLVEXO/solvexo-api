import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { AdminTwoFactorService } from '../auth/admin-two-factor.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EmailService } from '../otp/services/email.service';
import { STAFF_PERMISSIONS } from '../staff/schemas/staff-member.schema';
import { escapeHtml } from '../newsletter/marketing-email.util';
import { ADMIN_PERMISSIONS, ADMIN_PRESET_ROLES } from './admin-permissions';
import { ADMIN_APPROVAL_ACTIONS, APPROVAL_GRANT_TTL_MIN } from './admin-approval.util';

const INVITE_EXPIRY_DAYS = 7;
const RESET_EXPIRY_MINUTES = 60;
const VIEW_AS_MINUTES = 30;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const known = new Set<string>(ADMIN_PERMISSIONS);

/** Who is calling: the owner / a Super Admin (never restricted) or a team admin holding `team.manage`. */
export interface Actor { userId: string; teamAdmin?: boolean; permissions?: string[]; name?: string }
const isSuper = (a: Actor) => !a.teamAdmin;

@Injectable()
export class AdminTeamService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly activity: ActivityLogService,
    private readonly email: EmailService,
    private readonly twoFactor: AdminTwoFactorService,
  ) {}

  private get admins() { return this.db.repositories.adminModel; }
  private get roles() { return this.db.repositories.adminRoleModel; }

  /** Existing admins predate the Team feature: when nobody is a Super Admin yet, every existing admin (the owner) becomes one. */
  async onModuleInit() {
    try {
      const anySuper = await this.admins.exists({ isSuperAdmin: true });
      if (!anySuper) await this.admins.updateMany({ isDelete: { $ne: true } }, { $set: { isSuperAdmin: true } });
    } catch { /* never block boot */ }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async log(actor: Actor, action: string, description: string, targetId?: string) {
    await this.activity.log({ category: 'admin_team', action, description, actorId: actor.userId, actorName: actor.name ?? null, actorRole: 'admin', targetId: targetId ?? null, targetType: 'admin' });
  }

  private async assertRoleGrantable(actor: Actor, permissions: string[]) {
    const bad = permissions.filter((p) => !known.has(p));
    if (bad.length) throw new BadRequestException(`Unknown permission: ${bad.join(', ')}`);
    if (isSuper(actor)) return;
    const mine = new Set(actor.permissions ?? []);
    const over = permissions.filter((p) => !mine.has(p));
    if (over.length) throw new ForbiddenException(`You can't grant permissions you don't have: ${over.join(', ')}`);
  }

  private async countSupers(excludeId?: string) {
    return this.admins.countDocuments({ isSuperAdmin: true, isDelete: { $ne: true }, status: 'active', ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  }

  private async getTarget(id: string) {
    const admin: any = await this.admins.findOne({ _id: id, isDelete: { $ne: true } });
    if (!admin) throw new NotFoundException('Admin not found');
    return admin;
  }

  /** A team admin may manage only team admins whose role it fully covers; Super Admins are out of its reach. */
  private async assertCanManage(actor: Actor, target: any) {
    if (String(target._id) === actor.userId) throw new ForbiddenException("You can't change your own role, access or status.");
    if (isSuper(actor)) return;
    if (target.isSuperAdmin) throw new ForbiddenException('Only a Super Admin can manage a Super Admin.');
    const role: any = target.roleId ? await this.roles.findOne({ _id: target.roleId, isDelete: false }).select('permissions').lean() : null;
    const mine = new Set(actor.permissions ?? []);
    if ((role?.permissions ?? []).some((p: string) => !mine.has(p))) throw new ForbiddenException("You can't manage an admin whose role has more access than yours.");
  }

  private view(a: any, roleName: string | null) {
    const expired = a.accessExpiresAt && new Date(a.accessExpiresAt).getTime() < Date.now();
    const state = a.status !== 'active' ? 'inactive' : expired ? 'access_expired' : a.inviteSentAt && !a.inviteAcceptedAt && !a.isVerified ? 'invited' : 'active';
    return {
      _id: a._id, name: a.name, email: a.email, phone: a.phone ?? '', profileImage: a.profileImage ?? null, isSuperAdmin: !!a.isSuperAdmin,
      roleId: a.roleId ?? null, roleName, status: a.status, state, accessExpiresAt: a.accessExpiresAt ?? null,
      inviteSentAt: a.inviteSentAt ?? null, inviteTokenExpiresAt: a.inviteTokenExpiresAt ?? null, lastLoginAt: a.lastLoginAt ?? null, lastLoginIp: a.lastLoginIp ?? null,
      sessionCount: (a.sessions ?? []).length, twoFactorEnabled: !!a.twoFactorEnabled, createdAt: a.createdAt,
    };
  }

  // ── roles ─────────────────────────────────────────────────────────────────
  private async ensurePresets() {
    const existing: any[] = await this.roles.find({ isPreset: true }).select('presetKey').lean();
    const have = new Set(existing.map((r) => r.presetKey));
    const missing = ADMIN_PRESET_ROLES.filter((p) => !have.has(p.key));
    if (missing.length) await this.roles.insertMany(missing.map((p) => ({ name: p.name, description: p.description, permissions: p.permissions, readOnly: p.readOnly, isPreset: true, presetKey: p.key })));
  }

  async listRoles() {
    await this.ensurePresets();
    const roles: any[] = await this.roles.find({ isDelete: false }).sort({ isPreset: -1, name: 1 }).lean();
    const counts: any[] = await this.admins.aggregate([{ $match: { isDelete: { $ne: true }, roleId: { $ne: null } } }, { $group: { _id: '$roleId', n: { $sum: 1 } } }]);
    const by = new Map(counts.map((c) => [String(c._id), c.n]));
    return { success: true, data: roles.map((r) => ({ ...r, adminCount: by.get(String(r._id)) ?? 0 })) };
  }

  async createRole(actor: Actor, dto: { name: string; description?: string; permissions: string[]; readOnly?: boolean }) {
    await this.assertRoleGrantable(actor, dto.permissions);
    const name = dto.name.trim();
    if (await this.roles.exists({ name, isDelete: false })) throw new BadRequestException('A role with this name already exists.');
    const role = await this.roles.create({ name, description: dto.description?.trim() || null, permissions: dto.permissions, readOnly: !!dto.readOnly });
    await this.log(actor, 'admin_role_created', `Admin role "${name}" created`, String(role._id));
    return { success: true, data: role };
  }

  async updateRole(actor: Actor, id: string, dto: { name?: string; description?: string; permissions?: string[]; readOnly?: boolean }) {
    const role: any = await this.roles.findOne({ _id: id, isDelete: false });
    if (!role) throw new NotFoundException('Role not found');
    await this.assertRoleGrantable(actor, [...(role.permissions ?? []), ...(dto.permissions ?? [])]);
    if (dto.name !== undefined) role.name = dto.name.trim();
    if (dto.description !== undefined) role.description = dto.description.trim() || null;
    if (dto.permissions !== undefined) role.permissions = dto.permissions;
    if (dto.readOnly !== undefined) role.readOnly = dto.readOnly;
    await role.save();
    // Everyone on this role signs in again with the new access.
    await this.revokeSessionsWhere({ roleId: id });
    await this.log(actor, 'admin_role_updated', `Admin role "${role.name}" updated`, id);
    return { success: true, data: role.toObject() };
  }

  async removeRole(actor: Actor, id: string) {
    const role: any = await this.roles.findOne({ _id: id, isDelete: false });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isPreset) throw new BadRequestException('Preset roles cannot be deleted.');
    await this.assertRoleGrantable(actor, role.permissions ?? []);
    const inUse = await this.admins.countDocuments({ roleId: id, isDelete: { $ne: true } });
    if (inUse) throw new BadRequestException(`${inUse} admin(s) use this role — move them to another role first.`);
    role.isDelete = true;
    await role.save();
    await this.log(actor, 'admin_role_deleted', `Admin role "${role.name}" deleted`, id);
    return { success: true, message: 'Role deleted' };
  }

  private async revokeSessionsWhere(filter: Record<string, any>) {
    await this.admins.updateMany({ ...filter, isSuperAdmin: { $ne: true } }, { $set: { sessions: [] }, $inc: { tokenVersion: 1 } });
  }

  // ── admins ────────────────────────────────────────────────────────────────
  async listAdmins() {
    const admins: any[] = await this.admins.find({ isDelete: { $ne: true } }).sort({ isSuperAdmin: -1, createdAt: 1 }).lean();
    const roles: any[] = await this.roles.find({ isDelete: false }).select('name').lean();
    const names = new Map(roles.map((r) => [String(r._id), r.name]));
    return { success: true, data: admins.map((a) => this.view(a, a.roleId ? names.get(String(a.roleId)) ?? null : null)) };
  }

  async invite(actor: Actor, dto: { name: string; email: string; roleId: string; accessExpiresAt?: string | null }) {
    const email = dto.email.toLowerCase().trim();
    const role: any = await this.roles.findOne({ _id: dto.roleId, isDelete: false }).select('permissions name').lean();
    if (!role) throw new BadRequestException('Pick a role for this admin.');
    await this.assertRoleGrantable(actor, role.permissions ?? []);
    if (await this.admins.exists({ email })) throw new BadRequestException('An admin with this email already exists.');
    const accessExpiresAt = dto.accessExpiresAt ? new Date(dto.accessExpiresAt) : null;
    if (accessExpiresAt && (isNaN(accessExpiresAt.getTime()) || accessExpiresAt.getTime() < Date.now())) throw new BadRequestException('Access end date must be in the future.');

    const token = randomBytes(24).toString('hex');
    const admin: any = await this.admins.create({
      name: dto.name.trim(), email, role: 'admin', status: 'active', isVerified: false, isSuperAdmin: false, roleId: dto.roleId,
      password: await bcrypt.hash(randomBytes(32).toString('hex'), 10), // unusable until the invite is accepted
      inviteTokenHash: sha256(token), inviteTokenExpiresAt: new Date(Date.now() + INVITE_EXPIRY_DAYS * 86400000), inviteSentAt: new Date(),
      accessExpiresAt, createdByAdminId: actor.userId,
    });
    const sent = await this.sendInvite(admin.name, admin.email, token, role.name);
    await this.log(actor, 'admin_invited', `Admin "${admin.name}" (${admin.email}) invited as ${role.name}`, String(admin._id));
    return { success: true, data: this.view(admin.toObject(), role.name), emailSent: sent, ...(isSuper(actor) ? { inviteUrl: this.inviteUrl(token) } : {}) };
  }

  private inviteUrl(token: string) { return `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/admin-invite/${token}`; }

  private async sendInvite(name: string, email: string, token: string, roleName: string): Promise<boolean> {
    const url = this.inviteUrl(token);
    const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;"><h2>You've been invited to the ${escapeHtml(process.env.APP_NAME || 'Solvexo')} admin team</h2>
      <p>Hi ${escapeHtml(name)}, you were added as <strong>${escapeHtml(roleName)}</strong>. Set your own password to activate your account.</p>
      <p><a href="${url}" style="display:inline-block;background:#D97757;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Accept invite &amp; set password</a></p>
      <p style="color:#888;font-size:12px;">If the button doesn't work, copy this link: ${url}</p><p style="color:#888;font-size:12px;">This link expires in ${INVITE_EXPIRY_DAYS} days.</p></div>`;
    return this.email.sendMail(email, `You've been invited to the admin team`, html).catch(() => false);
  }

  async resendInvite(actor: Actor, id: string) {
    const admin = await this.getTarget(id);
    await this.assertCanManage(actor, admin);
    if (admin.inviteAcceptedAt || admin.isVerified) throw new BadRequestException('This admin has already accepted the invite.');
    const token = randomBytes(24).toString('hex');
    admin.inviteTokenHash = sha256(token); admin.inviteTokenExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 86400000); admin.inviteSentAt = new Date();
    await admin.save();
    const role: any = admin.roleId ? await this.roles.findById(admin.roleId).select('name').lean() : null;
    const sent = await this.sendInvite(admin.name, admin.email, token, role?.name ?? 'Admin');
    return { success: true, emailSent: sent, ...(isSuper(actor) ? { inviteUrl: this.inviteUrl(token) } : {}) };
  }

  async update(actor: Actor, id: string, dto: { name?: string; roleId?: string; status?: 'active' | 'inactive'; accessExpiresAt?: string | null }) {
    const admin = await this.getTarget(id);
    await this.assertCanManage(actor, admin);
    let revoke = false;
    if (dto.name !== undefined) admin.name = dto.name.trim();
    if (dto.roleId !== undefined && dto.roleId !== admin.roleId) {
      if (admin.isSuperAdmin) throw new BadRequestException('Demote this Super Admin first.');
      const role: any = await this.roles.findOne({ _id: dto.roleId, isDelete: false }).select('permissions').lean();
      if (!role) throw new BadRequestException('Role not found.');
      await this.assertRoleGrantable(actor, role.permissions ?? []);
      admin.roleId = dto.roleId; revoke = true;
    }
    if (dto.status !== undefined && dto.status !== admin.status) {
      if (dto.status === 'inactive' && admin.isSuperAdmin && (await this.countSupers(String(admin._id))) < 1) throw new BadRequestException("You can't deactivate the last Super Admin.");
      admin.status = dto.status; if (dto.status === 'inactive') revoke = true;
    }
    if (dto.accessExpiresAt !== undefined) {
      const d = dto.accessExpiresAt ? new Date(dto.accessExpiresAt) : null;
      if (d && (isNaN(d.getTime()) || d.getTime() < Date.now())) throw new BadRequestException('Access end date must be in the future.');
      admin.accessExpiresAt = d;
    }
    if (revoke) { admin.sessions = []; admin.tokenVersion = (admin.tokenVersion ?? 0) + 1; }
    await admin.save();
    await this.log(actor, 'admin_updated', `Admin "${admin.name}" updated`, id);
    return { success: true, data: (await this.listAdmins()).data.find((a: any) => String(a._id) === id) };
  }

  /** Super Admin only: promote a team admin to Super Admin, or demote one (never the last). */
  async setSuper(actor: Actor, id: string, makeSuper: boolean) {
    if (!isSuper(actor)) throw new ForbiddenException('Only a Super Admin can do this.');
    const admin = await this.getTarget(id);
    if (String(admin._id) === actor.userId) throw new ForbiddenException("You can't change your own Super Admin status.");
    if (!makeSuper && admin.isSuperAdmin && (await this.countSupers(String(admin._id))) < 1) throw new BadRequestException("You can't demote the last Super Admin.");
    admin.isSuperAdmin = makeSuper;
    if (makeSuper) admin.roleId = null;
    admin.sessions = []; admin.tokenVersion = (admin.tokenVersion ?? 0) + 1;
    await admin.save();
    await this.log(actor, makeSuper ? 'admin_promoted' : 'admin_demoted', `${admin.name} ${makeSuper ? 'promoted to' : 'removed from'} Super Admin`, id);
    return { success: true };
  }

  async remove(actor: Actor, id: string) {
    if (!isSuper(actor)) throw new ForbiddenException('Only a Super Admin can delete an admin.');
    const admin = await this.getTarget(id);
    await this.assertCanManage(actor, admin);
    if (admin.isSuperAdmin && (await this.countSupers(String(admin._id))) < 1) throw new BadRequestException("You can't delete the last Super Admin.");
    await this.admins.deleteOne({ _id: id });
    await this.log(actor, 'admin_deleted', `Admin "${admin.name}" (${admin.email}) deleted`, id);
    return { success: true, message: 'Admin deleted' };
  }

  async revokeAdminSessions(actor: Actor, id: string) {
    const admin = await this.getTarget(id);
    await this.assertCanManage(actor, admin);
    admin.sessions = []; admin.tokenVersion = (admin.tokenVersion ?? 0) + 1;
    await admin.save();
    await this.log(actor, 'admin_sessions_revoked', `All sessions of "${admin.name}" signed out`, id);
    return { success: true };
  }

  /** Lost phone and recovery codes: switches two-factor off so the admin can sign in with their password and set it up again. */
  async resetAdminTwoFactor(actor: Actor, id: string) {
    const admin = await this.getTarget(id);
    await this.assertCanManage(actor, admin);
    if (!admin.twoFactorEnabled) throw new BadRequestException('Two-factor sign-in is already off for this admin.');
    await this.twoFactor.clear(String(admin._id));
    // Their open sessions were made with the old phone; sign them out so the next sign-in starts clean.
    await this.admins.updateOne({ _id: admin._id }, { $set: { sessions: [] }, $inc: { tokenVersion: 1 } });
    await this.log(actor, 'admin_2fa_reset', `Two-factor sign-in reset for "${admin.name}" (${admin.email})`, id);
    return { success: true, message: 'Two-factor sign-in reset. They can sign in with their password and turn it on again.' };
  }

  // ── invite / password (public) ───────────────────────────────────────────
  async getInvite(token: string) {
    const admin: any = await this.admins.findOne({ inviteTokenHash: sha256(token) }).select('+inviteTokenHash name email roleId inviteTokenExpiresAt isVerified').lean();
    if (!admin) throw new NotFoundException('This invite link is invalid.');
    if (admin.isVerified) throw new BadRequestException('This invite has already been accepted — try logging in instead.');
    if (admin.inviteTokenExpiresAt && new Date(admin.inviteTokenExpiresAt) < new Date()) throw new BadRequestException('This invite link has expired — ask the platform owner to resend it.');
    const role: any = admin.roleId ? await this.roles.findById(admin.roleId).select('name').lean() : null;
    return { success: true, data: { name: admin.name, email: admin.email, roleName: role?.name ?? null } };
  }

  async acceptInvite(token: string, password: string) {
    const admin: any = await this.admins.findOne({ inviteTokenHash: sha256(token) }).select('+inviteTokenHash');
    if (!admin) throw new NotFoundException('This invite link is invalid.');
    if (admin.isVerified) throw new BadRequestException('This invite has already been accepted — try logging in instead.');
    if (admin.inviteTokenExpiresAt && new Date(admin.inviteTokenExpiresAt) < new Date()) throw new BadRequestException('This invite link has expired — ask the platform owner to resend it.');
    admin.password = await bcrypt.hash(password, 10);
    admin.isVerified = true; admin.inviteTokenHash = null; admin.inviteTokenExpiresAt = null; admin.inviteAcceptedAt = new Date();
    await admin.save();
    return { success: true, message: 'Password set — you can now sign in.' };
  }

  async forgotPassword(email: string) {
    const generic = { success: true, message: 'If that email belongs to an admin account, a reset link is on its way.' };
    const admin: any = await this.admins.findOne({ email: String(email).toLowerCase().trim(), isDelete: { $ne: true }, status: 'active', isVerified: true }).select('name email');
    if (!admin) return generic;
    const token = randomBytes(32).toString('hex');
    admin.resetTokenHash = sha256(token); admin.resetTokenExpiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60000);
    await admin.save();
    const url = `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/admin-reset-password/${token}`;
    const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;"><h2>Reset your admin password</h2><p>Hi ${escapeHtml(admin.name || '')}, use the button below to choose a new password.</p>
      <p><a href="${url}" style="display:inline-block;background:#D97757;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Choose a new password</a></p>
      <p style="color:#888;font-size:12px;">This link expires in ${RESET_EXPIRY_MINUTES} minutes. If you didn't ask for it, ignore this email.</p></div>`;
    this.email.sendMail(admin.email, 'Reset your admin password', html).catch(() => false);
    return generic;
  }

  async resetPassword(token: string, password: string) {
    const admin: any = await this.admins.findOne({ resetTokenHash: sha256(token), isDelete: { $ne: true } }).select('+resetTokenHash');
    if (!admin || !admin.resetTokenExpiresAt || admin.resetTokenExpiresAt < new Date()) throw new BadRequestException('This reset link is invalid or has expired — request a new one.');
    admin.password = await bcrypt.hash(password, 10);
    admin.resetTokenHash = null; admin.resetTokenExpiresAt = null; admin.failedLoginCount = 0; admin.lockedUntil = null;
    admin.sessions = []; admin.tokenVersion = (admin.tokenVersion ?? 0) + 1;
    await admin.save();
    return { success: true, message: 'Password updated — you can now sign in.' };
  }

  // ── my sessions ──────────────────────────────────────────────────────────
  async mySessions(adminId: string, currentSid: string | null) {
    const admin: any = await this.admins.findById(adminId).select('sessions').lean();
    const sessions = (admin?.sessions ?? []).map((s: any) => ({ ...s, current: !!currentSid && s.sid === currentSid })).sort((a: any, b: any) => +new Date(b.createdAt) - +new Date(a.createdAt));
    return { success: true, data: sessions };
  }

  async revokeMySession(adminId: string, sid: string) {
    await this.admins.updateOne({ _id: adminId }, { $pull: { sessions: { sid } } });
    return { success: true };
  }

  async revokeAllMine(adminId: string) {
    await this.admins.updateOne({ _id: adminId }, { $set: { sessions: [] }, $inc: { tokenVersion: 1 } });
    return { success: true, message: 'Signed out everywhere. Please sign in again.' };
  }

  // ── audit ────────────────────────────────────────────────────────────────
  async audit(query: any) {
    const category = ['admin_audit', 'admin_team'].includes(query.category) ? query.category : undefined;
    // buildAdminFilter takes one category: without a choice we show the audit trail (what admins did).
    return new ActivityAdapter(this.activity).list({ ...query, category: category ?? 'admin_audit' });
  }

  // ── approvals ────────────────────────────────────────────────────────────
  async listApprovals(status?: string) {
    const filter: any = status && status !== 'all' ? { status } : {};
    const items: any[] = await this.db.repositories.adminApprovalModel.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    const now = Date.now();
    return { success: true, data: items.map((i) => ({ ...i, actionLabel: ADMIN_APPROVAL_ACTIONS[i.action] ?? i.action, stale: i.status === 'pending' && new Date(i.expiresAt).getTime() < now })) };
  }

  async decide(actor: Actor, id: string, approve: boolean, note?: string) {
    if (!isSuper(actor)) throw new ForbiddenException('Only a Super Admin can approve or reject.');
    const admin: any = await this.admins.findById(actor.userId).select('name email').lean();
    const grantUntil = new Date(Date.now() + APPROVAL_GRANT_TTL_MIN * 60000);
    const res: any = await this.db.repositories.adminApprovalModel.findOneAndUpdate(
      { _id: id, status: 'pending', expiresAt: { $gt: new Date() } },
      { $set: { status: approve ? 'approved' : 'rejected', decidedBy: actor.userId, decidedByName: admin?.name ?? admin?.email ?? null, decidedAt: new Date(), note: note?.slice(0, 300) ?? null, ...(approve ? { expiresAt: grantUntil } : {}) } },
      { new: true },
    );
    if (!res) throw new BadRequestException('This request was already handled or has expired.');
    await this.log(actor, approve ? 'admin_approval_granted' : 'admin_approval_rejected', `${approve ? 'Approved' : 'Rejected'}: ${res.summary} (${res.requestedByName ?? res.requestedBy})`, String(res._id));
    return { success: true, data: res };
  }

  // ── view a store as an admin (read-only) ─────────────────────────────────
  async viewAsStore(actor: Actor, storeId: string) {
    const store: any = await this.db.repositories.storeModel.findById(storeId).select('name sellerId isDelete').lean();
    if (!store || store.isDelete) throw new NotFoundException('Store not found');
    const admin: any = await this.admins.findById(actor.userId).select('name email').lean();
    const payload = {
      sub: actor.userId, email: admin?.email, role: 'staff', storeId: String(store._id), sellerId: store.sellerId,
      permissions: [...STAFF_PERMISSIONS], viewOnly: true, viewAs: actor.userId, tokenVersion: 0,
    };
    const token = this.jwt.sign(payload, { expiresIn: `${VIEW_AS_MINUTES}m` });
    await this.redis.set(token, actor.userId, VIEW_AS_MINUTES * 60);
    await this.log(actor, 'admin_view_as_store', `Opened store "${store.name}" in read-only view`, String(store._id));
    return { success: true, data: { accessToken: token, storeId: String(store._id), storeName: store.name, minutes: VIEW_AS_MINUTES, staff: { id: actor.userId, name: `${admin?.name ?? 'Admin'} (admin view)`, email: admin?.email, role: 'staff', permissions: [...STAFF_PERMISSIONS], storeId: String(store._id) } } };
  }
}

/** Thin wrapper so the audit endpoint reuses ActivityLogService's admin filter (category/actor/search/date). */
class ActivityAdapter {
  constructor(private readonly activity: ActivityLogService) {}
  list(query: any) { return this.activity.adminFindAll(query); }
}
