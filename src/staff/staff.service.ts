/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { escapeHtml } from '../newsletter/marketing-email.util';
import { buildStaffProfile } from '../common/staff-profile.util';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { EmailService } from '../otp/services/email.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { AcceptStaffInviteDto } from './dto/accept-staff-invite.dto';
import { STAFF_PERMISSIONS } from './schemas/staff-member.schema';
import { EntitlementsService } from '../platform-plans/entitlements.service';

const INVITE_EXPIRY_DAYS = 7;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const RESET_EXPIRY_MINUTES = 60;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class StaffService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly activityLogService: ActivityLogService,
    private readonly emailService: EmailService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get repos() {
    return this.databaseService.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.repos.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  /** Resolves a `roleId` into its real `Role.permissions` — returns `[]`
   *  for `null`/a deleted role rather than throwing, since "no role yet" is
   *  a valid transient state (e.g. a staff account created before a role
   *  is assigned) and should just mean "no access", not a hard error. */
  private async resolvePermissions(storeId: string, roleId: string | null): Promise<string[]> {
    if (!roleId) return [];
    const role = await this.repos.roleModel.findOne({ _id: roleId, storeId, isDelete: false }).select('permissions').lean();
    // Roles saved before a permission was retired (e.g. buyer subscriptions) can
    // still carry its key — never hand those out.
    return ((role as any)?.permissions ?? []).filter((p: string) => (STAFF_PERMISSIONS as readonly string[]).includes(p));
  }

  /** Store-scoped staff login — a real email+password against `StaffMember`,
   *  never the seller's own `Seller` collection. Same JWT shape/signing
   *  mechanism as every other role, with `role:'staff'`, a required
   *  `storeId` claim, and `permissions` (resolved from the staff member's
   *  assigned `Role` at THIS moment, not cached anywhere) embedded directly
   *  (see JwtStrategy/PermissionsGuard). */
  async login(storeId: string, email: string, password: string) {
    const staff = await this.repos.staffMemberModel
      .findOne({ storeId, email: email.toLowerCase().trim(), isDelete: false })
      .select('+passwordHash');
    if (!staff) throw new UnauthorizedException('Invalid email or password');
    if (staff.status !== 'active') throw new UnauthorizedException('This staff account is inactive');
    // Staff act under the owning seller's account — a suspended/deleted
    // seller's staff must not be able to sign in (JwtAuthGuard enforces the
    // same for sessions that already exist).
    const owner: any = await this.repos.sellerModel.findById((staff as any).sellerId).select('status isDelete').lean();
    if (!owner || owner.isDelete || (owner.status && owner.status !== 'active')) {
      throw new UnauthorizedException('This staff account is inactive');
    }
    if (!(staff as any).passwordHash) {
      throw new UnauthorizedException("This invite hasn't been accepted yet — check the invite email for the setup link.");
    }

    const lockedUntil = (staff as any).lockedUntil as Date | null;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.`);
    }

    const match = await bcrypt.compare(password, (staff as any).passwordHash);
    if (!match) {
      // Atomic increment so parallel guesses can't dodge the counter.
      const updated: any = await this.repos.staffMemberModel.findByIdAndUpdate(staff._id, { $inc: { failedLoginCount: 1 } }, { new: true }).select('failedLoginCount').lean();
      if ((updated?.failedLoginCount ?? 0) >= MAX_FAILED_LOGINS) {
        await this.repos.staffMemberModel.updateOne({ _id: staff._id }, { $set: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60000) } });
      }
      throw new UnauthorizedException('Invalid email or password');
    }
    if ((staff as any).failedLoginCount || lockedUntil) {
      await this.repos.staffMemberModel.updateOne({ _id: staff._id }, { $set: { failedLoginCount: 0, lockedUntil: null } });
    }

    const permissions = await this.resolvePermissions(storeId, (staff as any).roleId);

    const payload = {
      sub: staff._id,
      email: staff.email,
      role: 'staff',
      tokenVersion: staff.tokenVersion ?? 0,
      storeId,
      permissions,
      sellerId: staff.sellerId,
    };
    const accessToken = this.jwtService.sign(payload);
    try {
      await this.redis.set(accessToken, staff._id.toString(), 24 * 60 * 60);
    } catch {
      // Redis unavailable — JwtAuthGuard already fails open on session-check
      // when disconnected, same as every other role's login.
    }

    return {
      success: true,
      data: {
        accessToken,
        staff: {
          id: staff._id, name: staff.name, email: staff.email,
          role: staff.role, roleId: (staff as any).roleId, permissions, storeId,
        },
      },
    };
  }

  /** Creating a staff account is a seller/admin-only action, OR a staff
   *  member who already holds `staff.manage` — but a staff creator can
   *  never assign a Role that grants a permission they don't themselves
   *  hold (privilege-escalation guard, checked against the target ROLE's
   *  real permission set, not a client-supplied list). */
  async create(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, dto: CreateStaffDto) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertCanManageStaff(actorRole, actorPermissions);

    if (dto.roleId) {
      await this.assertActorCanAssignRole(storeId, actorRole, actorPermissions, dto.roleId);
    }

    const existing = await this.repos.staffMemberModel.findOne({ storeId, email: dto.email.toLowerCase().trim() });
    if (existing) throw new BadRequestException('A staff member with this email already exists for this store');

    // Plan staff-account limit (Shopify-style: dashboard users only).
    await this.entitlementsService.assertCanAddStaff(storeId);

    const store = await this.repos.storeModel.findById(storeId).select('name sellerId contactEmail').lean() as any;
    const inviteToken = randomBytes(24).toString('hex');
    const staff = await this.repos.staffMemberModel.create({
      storeId,
      sellerId: actorRole === 'seller' ? actorId : store?.sellerId,
      name: dto.name,
      email: dto.email.toLowerCase().trim(),
      passwordHash: null,
      inviteToken,
      inviteTokenExpiresAt: new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      inviteSentAt: new Date(),
      role: dto.role ?? 'staff',
      roleId: dto.roleId ?? null,
      locationId: dto.locationId ?? null,
      status: 'active',
    });

    // Awaited (SMTP has an 8 s connect timeout) so the owner is told the truth
    // about delivery instead of a silent "Invite pending".
    const emailSent = await this.sendInviteEmail(store?.name ?? 'your store', dto.name, dto.email, inviteToken, store?.contactEmail ?? null).catch(() => false);

    this.activityLogService.log({
      storeId, category: 'settings', action: 'staff_member_added',
      description: `Staff member "${staff.name}" invited`,
      actorId, actorRole: actorRole as any,
      targetId: (staff as any)._id.toString(), targetType: 'staff_member',
    });

    const { passwordHash: _omit, inviteToken: _omit2, ...safe } = staff.toObject();
    return { success: true, data: safe, emailSent, ...this.inviteLinkFor(actorRole, inviteToken) };
  }

  /** Real invite email — best-effort/fire-and-forget from `create()`, same
   *  "a slow/broken SMTP must never block the actual mutation" convention
   *  as every other transactional email in this codebase. */
  // `storeContactEmail` becomes this email's reply-to — same real-world
  // reasoning as the order-confirmation email's own reply-to (see
  // payment.service.ts's sendOrderConfirmationEmails): a staff member
  // replying with a question should reach the actual store, not
  // Solvexo's own shared sender address. `null` (no contactEmail set on
  // that store yet) leaves replies going to the platform sender, same as
  // every other email in this codebase before that field existed.
  /** The raw invite link is a one-time credential for that staff account, so
   *  only the owner/admin may see it (a staff manager could otherwise set a
   *  colleague's password). Lets the owner share it by hand when the email
   *  lands in spam. */
  private inviteLinkFor(actorRole: string, token: string) {
    if (actorRole === 'staff') return {};
    return { inviteUrl: `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/staff-invite/${token}` };
  }

  private async sendInviteEmail(storeName: string, staffName: string, email: string, token: string, storeContactEmail: string | null): Promise<boolean> {
    const frontendBase = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const inviteUrl = `${frontendBase}/staff-invite/${token}`;
    const rawStoreName = storeName;
    storeName = escapeHtml(storeName);
    staffName = escapeHtml(staffName);
    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2>You've been invited to ${storeName}</h2>
        <p>Hi ${staffName},</p>
        <p>You've been added as a staff member on <strong>${storeName}</strong>'s Solvexo dashboard. Set your own password to activate your account.</p>
        <p><a href="${inviteUrl}" style="display:inline-block;background:#D97757;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Accept Invite &amp; Set Password</a></p>
        <p style="color:#888;font-size:12px;">If the button doesn't work, copy this link: ${inviteUrl}</p>
        <p style="color:#888;font-size:12px;">This link expires in ${INVITE_EXPIRY_DAYS} days. If you weren't expecting this, you can ignore this email.</p>
      </div>`;
    return this.emailService.sendMail(email, `You've been invited to ${rawStoreName}`, html, storeContactEmail);
  }

  /** Public (no JWT — the staff member has no account yet) — resolves an
   *  invite token to what the accept-invite page needs to display. Never
   *  leaks anything beyond name/email/store name. */
  async getInvite(token: string) {
    const staff = await this.repos.staffMemberModel
      .findOne({ inviteToken: token })
      .select('+inviteToken +passwordHash name email storeId inviteTokenExpiresAt')
      .lean();
    if (!staff) throw new NotFoundException('This invite link is invalid.');
    if ((staff as any).passwordHash) throw new BadRequestException('This invite has already been accepted — try logging in instead.');
    if ((staff as any).inviteTokenExpiresAt && new Date((staff as any).inviteTokenExpiresAt) < new Date()) {
      throw new BadRequestException('This invite link has expired — ask the store owner to resend it.');
    }
    const store = await this.repos.storeModel.findById((staff as any).storeId).select('name').lean() as any;
    return { success: true, data: { name: (staff as any).name, email: (staff as any).email, storeId: (staff as any).storeId, storeName: store?.name ?? null } };
  }

  /** Public — consumes the invite token exactly once, letting the staff
   *  member set their OWN password (the seller never knows/sets it). */
  async acceptInvite(token: string, dto: AcceptStaffInviteDto) {
    const staff = await this.repos.staffMemberModel
      .findOne({ inviteToken: token })
      .select('+inviteToken +passwordHash');
    if (!staff) throw new NotFoundException('This invite link is invalid.');
    if ((staff as any).passwordHash) throw new BadRequestException('This invite has already been accepted — try logging in instead.');
    if ((staff as any).inviteTokenExpiresAt && new Date((staff as any).inviteTokenExpiresAt) < new Date()) {
      throw new BadRequestException('This invite link has expired — ask the store owner to resend it.');
    }

    (staff as any).passwordHash = await bcrypt.hash(dto.password, 10);
    (staff as any).inviteToken = null;
    (staff as any).inviteTokenExpiresAt = null;
    (staff as any).inviteAcceptedAt = new Date();
    await staff.save();

    return { success: true, message: 'Password set — you can now log in.', data: { storeId: (staff as any).storeId } };
  }

  async list(actorId: string, actorRole: string, storeId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    const staff = await this.repos.staffMemberModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    return { success: true, data: staff };
  }

  async update(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, staffId: string, dto: UpdateStaffDto) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertCanManageStaff(actorRole, actorPermissions);

    if (actorRole === 'staff' && actorId === staffId) {
      throw new ForbiddenException("You can't edit your own role/permissions/status");
    }

    const staff = await this.repos.staffMemberModel.findOne({ _id: staffId, storeId, isDelete: false });
    if (!staff) throw new NotFoundException('Staff member not found');
    await this.assertActorCanManageTarget(storeId, actorRole, actorPermissions, (staff as any).roleId);

    if (dto.roleId !== undefined && dto.roleId !== null) {
      await this.assertActorCanAssignRole(storeId, actorRole, actorPermissions, dto.roleId);
    }

    // Re-activating a deactivated member takes a seat again — same limit
    // check as a new invite, so deactivate→invite→reactivate can't exceed it.
    if (dto.status === 'active' && staff.status !== 'active') {
      await this.entitlementsService.assertCanAddStaff(storeId);
    }

    let roleOrStatusChanged = false;
    if (dto.name !== undefined) staff.name = dto.name;
    if (dto.role !== undefined) { staff.role = dto.role as any; }
    if (dto.roleId !== undefined) { (staff as any).roleId = dto.roleId; roleOrStatusChanged = true; }
    if (dto.locationId !== undefined) staff.locationId = dto.locationId as any;
    if (dto.status !== undefined) { staff.status = dto.status; roleOrStatusChanged = true; }

    // A role/status change invalidates any already-issued token immediately
    // — same tokenVersion-bump revocation JwtAuthGuard already enforces for
    // User/Seller/Admin.
    if (roleOrStatusChanged) staff.tokenVersion = (staff.tokenVersion ?? 0) + 1;

    await staff.save();

    this.activityLogService.log({
      storeId, category: 'settings', action: 'staff_member_updated',
      description: `Staff member "${staff.name}" updated`,
      actorId, actorRole: actorRole as any,
      targetId: staffId, targetType: 'staff_member',
    });

    const { passwordHash: _omit, ...safe } = staff.toObject();
    return { success: true, data: safe };
  }

  async deactivate(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, staffId: string) {
    return this.update(actorId, actorRole, actorPermissions, storeId, staffId, { status: 'inactive' } as any);
  }

  /** Real "Resend Invite" — for the not-uncommon real case of an invite
   *  email getting lost/never arriving. Issues a genuinely fresh token
   *  (the old one, if any, stops working) rather than re-sending a stale
   *  one, same "never trust the passage of time" convention every other
   *  token-based flow in this codebase follows. Only meaningful while the
   *  invite is still unaccepted — an already-active staff member has
   *  nothing left to invite. */
  async resendInvite(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, staffId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertCanManageStaff(actorRole, actorPermissions);

    const staff = await this.repos.staffMemberModel.findOne({ _id: staffId, storeId, isDelete: false }).select('+passwordHash name email');
    if (!staff) throw new NotFoundException('Staff member not found');
    await this.assertActorCanManageTarget(storeId, actorRole, actorPermissions, (staff as any).roleId);
    if ((staff as any).passwordHash) throw new BadRequestException('This staff member has already accepted their invite.');

    const inviteToken = randomBytes(24).toString('hex');
    (staff as any).inviteToken = inviteToken;
    (staff as any).inviteTokenExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    (staff as any).inviteSentAt = new Date();
    await staff.save();

    const store = await this.repos.storeModel.findById(storeId).select('name contactEmail').lean() as any;
    const emailSent = await this.sendInviteEmail(store?.name ?? 'your store', (staff as any).name, (staff as any).email, inviteToken, store?.contactEmail ?? null).catch(() => false);

    return { success: true, message: emailSent ? 'Invite resent' : 'Invite saved but the email could not be sent', emailSent, ...this.inviteLinkFor(actorRole, inviteToken) };
  }

  /** Permanently removes a staff account (Shopify "Delete staff account").
   *  Hard delete so the email can be invited again later; the activity log
   *  keeps the audit trail. A staff actor can't delete themselves or anyone
   *  whose role grants more than they hold. */
  async remove(actorId: string, actorRole: string, actorPermissions: string[] | null, storeId: string, staffId: string) {
    if (actorRole === 'seller') await this.verifyStoreOwnership(storeId, actorId);
    this.assertCanManageStaff(actorRole, actorPermissions);
    if (actorRole === 'staff' && actorId === staffId) throw new ForbiddenException("You can't delete your own account");

    const staff = await this.repos.staffMemberModel.findOne({ _id: staffId, storeId, isDelete: false });
    if (!staff) throw new NotFoundException('Staff member not found');
    await this.assertActorCanManageTarget(storeId, actorRole, actorPermissions, (staff as any).roleId);

    await this.repos.staffMemberModel.deleteOne({ _id: staffId, storeId });
    // Kill any live session right away (tokenVersion check fails once the row is gone).
    this.activityLogService.log({
      storeId, category: 'settings', action: 'staff_member_deleted',
      description: `Staff member "${staff.name}" deleted`,
      actorId, actorRole: actorRole as any,
      targetId: staffId, targetType: 'staff_member',
    });
    return { success: true, message: 'Staff member deleted' };
  }

  // ── The signed-in staff member's OWN account ───────────────────────────

  async getOwnProfile(staffId: string) {
    return buildStaffProfile(this.repos, staffId);
  }

  async updateOwnProfile(staffId: string, dto: { name?: string }) {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Name is required');
    const staff = await this.repos.staffMemberModel.findOneAndUpdate({ _id: staffId, isDelete: false }, { $set: { name } }, { new: true });
    if (!staff) throw new NotFoundException('Staff member not found');
    return { success: true, message: 'Profile updated', data: await this.getOwnProfile(staffId) };
  }

  /** Verifies the current password, sets the new one, revokes every older
   *  session (tokenVersion bump) and hands back a fresh token so the staff
   *  member stays signed in on THIS device. */
  async changeOwnPassword(staffId: string, currentPassword: string, newPassword: string, currentToken?: string) {
    const staff = await this.repos.staffMemberModel.findOne({ _id: staffId, isDelete: false }).select('+passwordHash');
    if (!staff || !(staff as any).passwordHash) throw new NotFoundException('Staff member not found');
    if (!(await bcrypt.compare(currentPassword, (staff as any).passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (currentPassword === newPassword) throw new BadRequestException('New password must be different from the current one');

    (staff as any).passwordHash = await bcrypt.hash(newPassword, 10);
    staff.tokenVersion = (staff.tokenVersion ?? 0) + 1;
    await staff.save();
    if (currentToken) { try { await this.redis.del(currentToken); } catch { /* best-effort */ } }

    const accessToken = await this.issueToken(staff);
    return { success: true, message: 'Password changed successfully', data: { accessToken } };
  }

  private async issueToken(staff: any) {
    const permissions = await this.resolvePermissions(staff.storeId, staff.roleId);
    const accessToken = this.jwtService.sign({
      sub: staff._id, email: staff.email, role: 'staff', tokenVersion: staff.tokenVersion ?? 0,
      storeId: staff.storeId, permissions, sellerId: staff.sellerId,
    });
    try { await this.redis.set(accessToken, staff._id.toString(), 24 * 60 * 60); } catch { /* fails open like login */ }
    return accessToken;
  }

  // ── Forgot / reset password (public) ───────────────────────────────────

  /** Always answers the same way so it can't be used to discover which
   *  emails are staff accounts. */
  async forgotPassword(storeId: string, email: string) {
    const generic = { success: true, message: 'If that email belongs to a staff account on this store, a reset link is on its way.' };
    const staff: any = await this.repos.staffMemberModel
      .findOne({ storeId, email: String(email).toLowerCase().trim(), isDelete: false, status: 'active' })
      .select('+passwordHash name email');
    if (!staff || !staff.passwordHash) return generic; // unknown / not yet accepted (they use the invite link)

    const token = randomBytes(32).toString('hex');
    staff.resetTokenHash = sha256(token);
    staff.resetTokenExpiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60000);
    await staff.save();

    const store = await this.repos.storeModel.findById(storeId).select('name contactEmail').lean() as any;
    const url = `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/staff-reset-password/${token}`;
    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
        <h2>Reset your password</h2>
        <p>Hi ${escapeHtml(staff.name)}, we got a request to reset your password for <strong>${escapeHtml(store?.name ?? 'your store')}</strong>.</p>
        <p><a href="${url}" style="display:inline-block;background:#D97757;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Choose a new password</a></p>
        <p style="color:#888;font-size:12px;">This link expires in ${RESET_EXPIRY_MINUTES} minutes. If you didn't ask for this, you can ignore this email — your password stays the same.</p>
      </div>`;
    this.emailService.sendMail(staff.email, 'Reset your password', html, store?.contactEmail ?? null).catch(() => {});
    return generic;
  }

  async resetPassword(token: string, password: string) {
    const staff: any = await this.repos.staffMemberModel
      .findOne({ resetTokenHash: sha256(token), isDelete: false })
      .select('+resetTokenHash +passwordHash');
    if (!staff || !staff.resetTokenExpiresAt || staff.resetTokenExpiresAt < new Date()) {
      throw new BadRequestException('This reset link is invalid or has expired — request a new one.');
    }
    staff.passwordHash = await bcrypt.hash(password, 10);
    staff.resetTokenHash = null;
    staff.resetTokenExpiresAt = null;
    staff.failedLoginCount = 0;
    staff.lockedUntil = null;
    staff.tokenVersion = (staff.tokenVersion ?? 0) + 1; // signs out every old session
    await staff.save();
    return { success: true, message: 'Password updated — you can now sign in.', data: { storeId: staff.storeId } };
  }

  /** A staff actor can't touch (edit/deactivate/delete/re-invite) a colleague
   *  whose role grants anything they don't hold. Sellers/admins always pass. */
  private async assertActorCanManageTarget(storeId: string, actorRole: string, actorPermissions: string[] | null, targetRoleId: string | null) {
    if (actorRole !== 'staff') return;
    const targetPerms = await this.resolvePermissions(storeId, targetRoleId);
    const disallowed = targetPerms.filter((p) => !(actorPermissions ?? []).includes(p));
    if (disallowed.length > 0) throw new ForbiddenException("You can't manage a staff member whose role has more access than yours");
  }

  private assertCanManageStaff(actorRole: string, actorPermissions: string[] | null) {
    if (actorRole === 'seller' || actorRole === 'admin') return;
    if (actorRole === 'staff' && (actorPermissions ?? []).includes('staff.manage')) return;
    throw new ForbiddenException("You don't have permission to manage staff");
  }

  /** A staff member (never a seller/admin, who always pass unconditionally)
   *  can only assign a Role whose permissions are a SUBSET of their own —
   *  real privilege-escalation prevention, checked against the target
   *  Role's actual stored `permissions`, not anything client-supplied. */
  private async assertActorCanAssignRole(storeId: string, actorRole: string, actorPermissions: string[] | null, roleId: string) {
    if (actorRole !== 'staff') return;
    const role = await this.repos.roleModel.findOne({ _id: roleId, storeId, isDelete: false }).select('permissions name').lean();
    if (!role) throw new NotFoundException('Role not found');
    const disallowed = ((role as any).permissions ?? []).filter((p: string) => !(actorPermissions ?? []).includes(p));
    if (disallowed.length > 0) {
      throw new ForbiddenException(`You can't assign the "${(role as any).name}" role — it grants permissions you don't have: ${disallowed.join(', ')}`);
    }
  }

  listPermissions() {
    return { success: true, data: STAFF_PERMISSIONS };
  }
}
