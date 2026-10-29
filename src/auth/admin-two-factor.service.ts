/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { generateTotpSecret, totpAuthUri, verifyTotp } from '../common/totp.util';

const ISSUER = 'Solvexo Admin';
const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_MINUTES = 5;
const CHALLENGE_PURPOSE = 'admin_2fa';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const normalizeRecovery = (v: string) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Admin two-factor login with an authenticator app, plus one-time recovery codes for a lost phone.
 *  Login with 2FA on is two steps: password → short-lived challenge token → code → real session (AuthService). */
@Injectable()
export class AdminTwoFactorService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get admins() { return this.db.repositories.adminModel; }

  // Signed with a derived secret so a challenge token can never pass JwtAuthGuard as a session token.
  private get challengeSecret() { return `${this.config.get<string>('JWT_SECRET')}:${CHALLENGE_PURPOSE}`; }

  // ── login challenge ──────────────────────────────────────────────────────
  signChallenge(admin: any): string {
    return this.jwt.sign(
      { sub: String(admin._id), purpose: CHALLENGE_PURPOSE, tv: admin.tokenVersion ?? 0 },
      { secret: this.challengeSecret, expiresIn: `${CHALLENGE_MINUTES}m` },
    );
  }

  verifyChallenge(token: string): { adminId: string; tokenVersion: number } {
    try {
      const p: any = this.jwt.verify(token, { secret: this.challengeSecret });
      if (p?.purpose !== CHALLENGE_PURPOSE || !p.sub) throw new Error();
      return { adminId: String(p.sub), tokenVersion: p.tv ?? 0 };
    } catch {
      throw new UnauthorizedException('Your sign-in step expired. Enter your email and password again.');
    }
  }

  /** Accepts a current authenticator code or an unused recovery code (which is then used up). */
  async verifyLoginCode(adminId: string, code: string): Promise<{ ok: boolean; usedRecoveryCode: boolean; recoveryCodesLeft: number }> {
    const admin: any = await this.admins.findById(adminId).select('+twoFactorSecret +twoFactorRecoveryCodes +twoFactorLastStep twoFactorEnabled');
    if (!admin?.twoFactorEnabled || !admin.twoFactorSecret) return { ok: false, usedRecoveryCode: false, recoveryCodesLeft: 0 };
    const codes: string[] = admin.twoFactorRecoveryCodes ?? [];

    const step = verifyTotp(this.decrypt(admin.twoFactorSecret), code);
    if (step !== null) {
      // Atomic: two parallel requests with the same code can't both win.
      const res = await this.admins.updateOne({ _id: adminId, twoFactorLastStep: { $lt: step } }, { $set: { twoFactorLastStep: step } });
      return { ok: res.modifiedCount === 1, usedRecoveryCode: false, recoveryCodesLeft: codes.length };
    }

    const hash = sha256(normalizeRecovery(code));
    if (normalizeRecovery(code).length >= 10 && codes.includes(hash)) {
      const res = await this.admins.updateOne({ _id: adminId, twoFactorRecoveryCodes: hash }, { $pull: { twoFactorRecoveryCodes: hash } });
      return { ok: res.modifiedCount === 1, usedRecoveryCode: true, recoveryCodesLeft: codes.length - 1 };
    }
    return { ok: false, usedRecoveryCode: false, recoveryCodesLeft: codes.length };
  }

  // ── self-service setup ───────────────────────────────────────────────────
  async status(adminId: string) {
    const admin: any = await this.admins.findById(adminId).select('twoFactorEnabled twoFactorEnabledAt +twoFactorRecoveryCodes').lean();
    return { success: true, data: { enabled: !!admin?.twoFactorEnabled, enabledAt: admin?.twoFactorEnabledAt ?? null, recoveryCodesLeft: (admin?.twoFactorRecoveryCodes ?? []).length } };
  }

  /** Step 1: a new secret to scan. Nothing changes for login until it's confirmed with a code. */
  async startSetup(adminId: string) {
    const admin: any = await this.admins.findById(adminId).select('email twoFactorEnabled');
    if (!admin) throw new UnauthorizedException();
    if (admin.twoFactorEnabled) throw new BadRequestException('Two-factor sign-in is already on. Turn it off first to move it to a new phone.');
    const secret = generateTotpSecret();
    await this.admins.updateOne({ _id: adminId }, { $set: { twoFactorPendingSecret: this.encrypt(secret) } });
    return { success: true, data: { secret, otpauthUri: totpAuthUri(secret, admin.email, ISSUER), issuer: ISSUER, account: admin.email } };
  }

  /** Step 2: the first code from the app proves it was scanned correctly; returns the recovery codes (shown once). */
  async confirmSetup(adminId: string, code: string) {
    const admin: any = await this.admins.findById(adminId).select('+twoFactorPendingSecret twoFactorEnabled');
    if (!admin) throw new UnauthorizedException();
    if (admin.twoFactorEnabled) throw new BadRequestException('Two-factor sign-in is already on.');
    if (!admin.twoFactorPendingSecret) throw new BadRequestException('Start the setup again — no pending setup was found.');
    const step = verifyTotp(this.decrypt(admin.twoFactorPendingSecret), code);
    if (step === null) throw new BadRequestException("That code didn't match. Check your phone's time is set automatically and try the newest code.");
    const recoveryCodes = this.newRecoveryCodes();
    await this.admins.updateOne({ _id: adminId }, {
      $set: {
        twoFactorEnabled: true, twoFactorEnabledAt: new Date(), twoFactorSecret: admin.twoFactorPendingSecret, twoFactorPendingSecret: null,
        twoFactorRecoveryCodes: recoveryCodes.map((c) => sha256(normalizeRecovery(c))), twoFactorLastStep: step,
      },
    });
    return { success: true, message: 'Two-factor sign-in is on.', data: { recoveryCodes } };
  }

  /** Needs the password AND a current code (or recovery code), so a stolen open session alone can't switch it off. */
  async disable(adminId: string, password: string, code: string) {
    await this.assertPassword(adminId, password);
    const { ok } = await this.verifyLoginCode(adminId, code);
    if (!ok) throw new BadRequestException("That code didn't match.");
    await this.clear(adminId);
    return { success: true, message: 'Two-factor sign-in is off.' };
  }

  async regenerateRecoveryCodes(adminId: string, password: string, code: string) {
    await this.assertPassword(adminId, password);
    const { ok } = await this.verifyLoginCode(adminId, code);
    if (!ok) throw new BadRequestException("That code didn't match.");
    const recoveryCodes = this.newRecoveryCodes();
    await this.admins.updateOne({ _id: adminId }, { $set: { twoFactorRecoveryCodes: recoveryCodes.map((c) => sha256(normalizeRecovery(c))) } });
    return { success: true, data: { recoveryCodes } };
  }

  /** Lost phone and recovery codes: a Super Admin / team manager resets it (AdminTeamService checks who may). */
  async clear(adminId: string) {
    await this.admins.updateOne({ _id: adminId }, {
      $set: { twoFactorEnabled: false, twoFactorEnabledAt: null, twoFactorSecret: null, twoFactorPendingSecret: null, twoFactorRecoveryCodes: [], twoFactorLastStep: 0 },
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async assertPassword(adminId: string, password: string) {
    const admin: any = await this.admins.findById(adminId).select('password');
    if (!admin || !password || !(await bcrypt.compare(password, admin.password))) throw new BadRequestException('Your password is incorrect.');
  }

  private newRecoveryCodes(): string[] {
    // 10 characters from an unambiguous alphabet, shown as XXXXX-XXXXX.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const bytes = randomBytes(10);
      const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
  }

  private encrypt(secret: string) { return encryptCredential(secret, 'ADMIN_2FA'); }
  private decrypt(payload: string) { return decryptCredential(payload, 'ADMIN_2FA'); }
}
