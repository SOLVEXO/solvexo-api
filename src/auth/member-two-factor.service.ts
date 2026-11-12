/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { generateTotpSecret, totpAuthUri, verifyTotp } from '../common/totp.util';
import { MemberTwoFactor, MemberTwoFactorDocument } from './member-two-factor.schema';

export type MemberKind = 'seller' | 'staff';
const ISSUER = 'Solvexo';
const RECOVERY_CODE_COUNT = 10;
export const MAX_FAILED_CODES = 5;
export const LOCK_MINUTES = 15;
const CHALLENGE = 'member_2fa';
const STEP_UP = 'member_2fa_stepup';
export const STEP_UP_MINUTES = 10;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const normalizeRecovery = (v: string) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Two-factor (authenticator app + recovery codes) for sellers and store staff, built on the same TOTP helpers and recovery-code rules as
 * the platform-admin implementation. State lives in its own collection so the Seller / Staff documents never carry the secret.
 * Wrong codes lock the member after 5 tries (15 min); a code (or recovery code) works once.
 */
@Injectable()
export class MemberTwoFactorService {
  constructor(
    @InjectModel(MemberTwoFactor.name) private readonly model: Model<MemberTwoFactorDocument>,
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private secretFor(purpose: string) { return `${this.config.get<string>('JWT_SECRET')}:${purpose}`; }
  private enc(s: string) { return encryptCredential(s, 'ADMIN_2FA'); }
  private dec(s: string) { return decryptCredential(s, 'ADMIN_2FA'); }

  async isEnabled(kind: MemberKind, memberId: string): Promise<boolean> {
    return !!(await this.model.exists({ kind, memberId: String(memberId), enabled: true }));
  }

  // ── login challenge ─────────────────────────────────────────────────────
  signChallenge(kind: MemberKind, memberId: string, extra: { tokenVersion?: number; storeId?: string } = {}): string {
    return this.jwt.sign({ sub: String(memberId), kind, purpose: CHALLENGE, tv: extra.tokenVersion ?? 0, sid: extra.storeId ?? null }, { secret: this.secretFor(CHALLENGE), expiresIn: '5m' });
  }
  verifyChallenge(token: string): { kind: MemberKind; memberId: string; tokenVersion: number; storeId: string | null } {
    try {
      const p: any = this.jwt.verify(token, { secret: this.secretFor(CHALLENGE) });
      if (p?.purpose !== CHALLENGE || !p.sub || !['seller', 'staff'].includes(p.kind)) throw new Error();
      return { kind: p.kind, memberId: String(p.sub), tokenVersion: p.tv ?? 0, storeId: p.sid ?? null };
    } catch { throw new UnauthorizedException('Your sign-in step expired. Enter your email and password again.'); }
  }

  /** A current authenticator code or an unused recovery code. Counts failures; locks after too many. */
  async verifyCode(kind: MemberKind, memberId: string, code: string): Promise<{ ok: boolean; usedRecoveryCode: boolean; recoveryCodesLeft: number }> {
    const row: any = await this.model.findOne({ kind, memberId: String(memberId), enabled: true }).lean();
    if (!row) return { ok: false, usedRecoveryCode: false, recoveryCodesLeft: 0 };
    if (row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
      throw new HttpException(`Too many wrong codes. Try again in ${Math.ceil((new Date(row.lockedUntil).getTime() - Date.now()) / 60000)} minute(s).`, 429);
    }
    const codes: string[] = row.recoveryHashes ?? [];
    let ok = false; let usedRecovery = false; let left = codes.length;
    const step = verifyTotp(this.dec(row.secretEnc), code);
    if (step !== null) {
      ok = (await this.model.updateOne({ _id: row._id, lastStep: { $lt: step } }, { $set: { lastStep: step } })).modifiedCount === 1; // replay: a code works once
    } else {
      const hash = sha256(normalizeRecovery(code));
      if (normalizeRecovery(code).length >= 10 && codes.includes(hash)) {
        ok = (await this.model.updateOne({ _id: row._id, recoveryHashes: hash }, { $pull: { recoveryHashes: hash } })).modifiedCount === 1;
        usedRecovery = ok; left = codes.length - (ok ? 1 : 0);
      }
    }
    if (ok) { if (row.failedCount) await this.model.updateOne({ _id: row._id }, { $set: { failedCount: 0, lockedUntil: null } }); return { ok, usedRecoveryCode: usedRecovery, recoveryCodesLeft: left }; }
    const upd: any = await this.model.findOneAndUpdate({ _id: row._id }, { $inc: { failedCount: 1 } }, { new: true }).lean();
    if ((upd?.failedCount ?? 0) >= MAX_FAILED_CODES) await this.model.updateOne({ _id: row._id }, { $set: { failedCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
    return { ok: false, usedRecoveryCode: false, recoveryCodesLeft: left };
  }

  // ── self-service ────────────────────────────────────────────────────────
  async status(kind: MemberKind, memberId: string) {
    const r: any = await this.model.findOne({ kind, memberId: String(memberId) }).lean();
    return { enabled: !!r?.enabled, enabledAt: r?.enabledAt ?? null, recoveryCodesLeft: r?.enabled ? (r.recoveryHashes ?? []).length : 0 };
  }

  async startSetup(kind: MemberKind, memberId: string, email: string) {
    if (await this.isEnabled(kind, memberId)) throw new BadRequestException('Two-factor sign-in is already on. Turn it off first to move it to a new phone.');
    const secret = generateTotpSecret();
    await this.model.updateOne({ kind, memberId: String(memberId) }, { $set: { pendingSecretEnc: this.enc(secret) }, $setOnInsert: { kind, memberId: String(memberId), enabled: false } }, { upsert: true });
    return { secret, otpauthUri: totpAuthUri(secret, email, ISSUER), issuer: ISSUER, account: email };
  }

  async confirmSetup(kind: MemberKind, memberId: string, code: string) {
    const row: any = await this.model.findOne({ kind, memberId: String(memberId) }).lean();
    if (!row?.pendingSecretEnc) throw new BadRequestException('Start the setup again — no pending setup was found.');
    if (row.enabled) throw new BadRequestException('Two-factor sign-in is already on.');
    const step = verifyTotp(this.dec(row.pendingSecretEnc), code);
    if (step === null) throw new BadRequestException("That code didn't match. Check your phone's time is set automatically and try the newest code.");
    const codes = this.newRecoveryCodes();
    await this.model.updateOne({ _id: row._id }, { $set: { enabled: true, enabledAt: new Date(), secretEnc: row.pendingSecretEnc, pendingSecretEnc: null, recoveryHashes: codes.map((c) => sha256(normalizeRecovery(c))), lastStep: step, failedCount: 0, lockedUntil: null } });
    return { recoveryCodes: codes };
  }

  /** Needs the password AND a current code, so a stolen open session alone cannot switch it off. */
  async disable(kind: MemberKind, memberId: string, password: string, code: string) {
    await this.assertPassword(kind, memberId, password);
    if (!(await this.verifyCode(kind, memberId, code)).ok) throw new BadRequestException("That code didn't match.");
    await this.reset(kind, memberId);
  }

  async regenerate(kind: MemberKind, memberId: string, password: string, code: string) {
    await this.assertPassword(kind, memberId, password);
    if (!(await this.verifyCode(kind, memberId, code)).ok) throw new BadRequestException("That code didn't match.");
    const codes = this.newRecoveryCodes();
    await this.model.updateOne({ kind, memberId: String(memberId) }, { $set: { recoveryHashes: codes.map((c) => sha256(normalizeRecovery(c))) } });
    return { recoveryCodes: codes };
  }

  /** Lost phone and recovery codes: the owner (or a platform admin) resets it. The caller checks who may and writes the audit entry. */
  async reset(kind: MemberKind, memberId: string) {
    await this.model.deleteOne({ kind, memberId: String(memberId) });
  }

  // ── step-up (sensitive actions) ─────────────────────────────────────────
  /** After a fresh code the member gets a 10-minute token to send in the `x-step-up` header on sensitive actions. */
  async issueStepUp(kind: MemberKind, memberId: string, code: string): Promise<{ token: string; expiresInMinutes: number }> {
    if (!(await this.verifyCode(kind, memberId, code)).ok) throw new BadRequestException("That code didn't match.");
    return { token: this.jwt.sign({ sub: String(memberId), kind, purpose: STEP_UP }, { secret: this.secretFor(STEP_UP), expiresIn: `${STEP_UP_MINUTES}m` }), expiresInMinutes: STEP_UP_MINUTES };
  }

  /** Members without two-factor pass (it cannot be demanded of them); members with it need a valid, own, unexpired step-up token. */
  async assertStepUp(kind: MemberKind, memberId: string, token: string | undefined): Promise<void> {
    if (!(await this.isEnabled(kind, memberId))) return;
    try {
      const p: any = this.jwt.verify(String(token ?? ''), { secret: this.secretFor(STEP_UP) });
      if (p?.purpose === STEP_UP && p.kind === kind && String(p.sub) === String(memberId)) return;
    } catch { /* fall through */ }
    throw new ForbiddenException({ message: 'Enter a code from your authenticator app to continue.', code: 'STEP_UP_REQUIRED' });
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  private async assertPassword(kind: MemberKind, memberId: string, password: string) {
    const repos: any = this.db.repositories;
    const m: any = kind === 'seller' ? await repos.sellerModel.findById(memberId).select('password') : await repos.staffMemberModel.findById(memberId).select('+passwordHash');
    const hash = kind === 'seller' ? m?.password : m?.passwordHash;
    if (!hash || !password || !(await bcrypt.compare(password, hash))) throw new BadRequestException('Your password is incorrect.');
  }

  private newRecoveryCodes(): string[] {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => { const raw = Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join(''); return `${raw.slice(0, 5)}-${raw.slice(5)}`; });
  }
}
