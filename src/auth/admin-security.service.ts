import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

export const ADMIN_MAX_FAILED_LOGINS = 5;
export const ADMIN_LOCKOUT_MINUTES = 15;
const MAX_SESSIONS = 15;
const MAX_KNOWN_DEVICES = 20;

export interface AdminLoginClaims { sid: string; teamAdmin?: true; permissions?: string[]; readOnly?: true }

/** Admin-only login rules that sit next to AuthService.login: lockout, invite/temporary-access checks, session
 *  tracking (so a session can be listed and revoked), the extra JWT claims of a TEAM admin, and the new-device
 *  alert. The platform owner / Super Admin gets a session id but no team claims = unrestricted. */
@Injectable()
export class AdminSecurityService {
  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private get admins() { return this.db.repositories.adminModel; }

  /** A team admin = has a role and is not a Super Admin. An admin with neither (legacy owner) stays unrestricted. */
  isTeamAdmin(admin: any): boolean { return !admin.isSuperAdmin && !!admin.roleId; }

  /** Before the password is even compared. */
  assertCanAttempt(admin: any) {
    if (admin.lockedUntil && new Date(admin.lockedUntil).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(admin.lockedUntil).getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.`);
    }
    if (admin.inviteSentAt && !admin.inviteAcceptedAt && !admin.isVerified) {
      throw new UnauthorizedException("This invite hasn't been accepted yet. Use the link in your invite email to set your password.");
    }
  }

  /** Atomic counter so parallel guesses can't dodge the lock. */
  async recordFailure(admin: any) {
    const updated: any = await this.admins.findByIdAndUpdate(admin._id, { $inc: { failedLoginCount: 1 } }, { new: true }).select('failedLoginCount').lean();
    if ((updated?.failedLoginCount ?? 0) >= ADMIN_MAX_FAILED_LOGINS) {
      await this.admins.updateOne({ _id: admin._id }, { $set: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + ADMIN_LOCKOUT_MINUTES * 60000) } });
    }
  }

  async resolveRole(roleId: string | null): Promise<{ permissions: string[]; readOnly: boolean }> {
    if (!roleId) return { permissions: [], readOnly: false };
    const role: any = await this.db.repositories.adminRoleModel.findOne({ _id: roleId, isDelete: false }).select('permissions readOnly').lean();
    return { permissions: role?.permissions ?? [], readOnly: !!role?.readOnly };
  }

  /** After the password (and account status) checks passed: returns the claims to put in the JWT. */
  async onSuccess(admin: any, ip?: string, userAgent?: string): Promise<AdminLoginClaims> {
    if (admin.accessExpiresAt && new Date(admin.accessExpiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('Your temporary access has expired. Ask the platform owner to extend it.');
    }
    const sid = randomBytes(12).toString('hex');
    const device = createHash('sha256').update(`${ip ?? ''}|${(userAgent ?? '').slice(0, 120)}`).digest('hex').slice(0, 24);
    const knownDevices: string[] = admin.knownDevices ?? [];
    const isNewDevice = !knownDevices.includes(device);
    const now = new Date();

    const sessions = [...(admin.sessions ?? []), { sid, ip: ip ?? null, userAgent: (userAgent ?? '').slice(0, 200) || null, createdAt: now, lastSeenAt: now }].slice(-MAX_SESSIONS);
    await this.admins.updateOne({ _id: admin._id }, {
      $set: {
        failedLoginCount: 0, lockedUntil: null, lastLoginAt: now, lastLoginIp: ip ?? null, sessions,
        knownDevices: isNewDevice ? [...knownDevices, device].slice(-MAX_KNOWN_DEVICES) : knownDevices,
      },
    });

    // A first-ever login is not suspicious; a NEW device after that tells the Super Admins.
    if (isNewDevice && knownDevices.length > 0) void this.alertNewDevice(admin, ip, userAgent);

    if (!this.isTeamAdmin(admin)) return { sid };
    const { permissions, readOnly } = await this.resolveRole(admin.roleId);
    return { sid, teamAdmin: true, permissions, ...(readOnly ? { readOnly: true as const } : {}) };
  }

  /** Used by JwtAuthGuard: a token with a session id is only valid while that session is still on the account. */
  async assertSessionActive(adminId: string, sid: string) {
    const admin: any = await this.admins.findOne({ _id: adminId, 'sessions.sid': sid }).select('status isDelete accessExpiresAt').lean();
    if (!admin || admin.isDelete || (admin.status && admin.status !== 'active')) {
      throw new UnauthorizedException('Session revoked, please login again');
    }
    if (admin.accessExpiresAt && new Date(admin.accessExpiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('Your temporary access has expired.');
    }
  }

  private async alertNewDevice(admin: any, ip?: string, userAgent?: string) {
    try {
      const supers: any[] = await this.admins.find({ isSuperAdmin: true, isDelete: false }).select('_id').lean();
      const body = `${admin.name || admin.email} signed in from a new device (${ip ?? 'unknown IP'}${userAgent ? `, ${userAgent.slice(0, 60)}` : ''}). If this wasn't them, remove their access in Admin Settings → Team.`;
      await Promise.all(supers.map((s) => this.notifications?.notify({
        recipientId: String(s._id), recipientRole: 'admin', type: NOTIFICATION_TYPES.ADMIN_SECURITY_ALERT,
        title: 'New admin sign-in', body, data: { link: '/admin/settings?tab=team' },
      })));
    } catch { /* an alert must never break a login */ }
  }
}
