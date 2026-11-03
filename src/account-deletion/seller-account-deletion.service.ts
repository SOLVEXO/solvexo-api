/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, UnauthorizedException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '@/database/databaseservice';
import { PosTokenRevocationService } from '../pos/pos-token-revocation.service';
import { AuthService } from '../auth/auth.service';
import { OtpService } from '../otp/otp.service';
import { generateOtp, assertOtpAttempt } from '../common/otp.util';

/** Proof of identity for a deletion request: the account password OR a fresh Google/Apple sign-in. */
export interface DeletionReauth { password?: string; authProvider?: string; socialId?: string; token?: string }

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const GENERIC_OTP_MESSAGE = 'If an account exists for that email, we have sent a verification code to it.';

const DAY_MS = 86_400_000;
/** How long a deleted account can still be restored before its personal data is erased. */
export const DELETION_GRACE_DAYS = 30;

/**
 * Seller (store owner) account deletion — in-app and on the web, same rules:
 *  1. REQUEST (re-auth with the password): the account becomes `pending_deletion`, every session/device/employee token is revoked
 *     at once, the stores are suspended (storefront + POS go dark) and a purge is scheduled in {@link DELETION_GRACE_DAYS} days.
 *     The owner can cancel within the grace period.
 *  2. PURGE (scheduled): personal data is DE-IDENTIFIED — not the books. Sales, taxes, payments, refunds and ledger rows stay
 *     (legal record-keeping) but lose the people in them: customer names/ids/notes, cashier names. The owner and employees are
 *     anonymised, PINs/passwords/social ids/devices are removed.
 */
@Injectable()
export class SellerAccountDeletionService {
  private readonly logger = new Logger(SellerAccountDeletionService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    @Optional() private readonly revocations?: PosTokenRevocationService,
    @Optional() private readonly auth?: AuthService,
    @Optional() private readonly otpService?: OtpService,
  ) {}

  private get r() { return this.databaseService.repositories; }

  async status(sellerId: string) {
    const s: any = await this.r.sellerModel.findById(sellerId).select('status deletionRequestedAt deletionScheduledFor password authProvider').lean();
    if (!s) throw new NotFoundException('Seller not found');
    return { success: true, data: { pending: s.status === 'pending_deletion', requestedAt: s.deletionRequestedAt ?? null, scheduledFor: s.deletionScheduledFor ?? null, graceDays: DELETION_GRACE_DAYS, hasPassword: !!s.password, authProvider: s.authProvider ?? null } };
  }

  /** Authenticated route: re-authenticate with the password or a fresh Google/Apple sign-in, then schedule the deletion. */
  async request(sellerId: string, reauth: DeletionReauth | string | undefined, ip?: string) {
    const creds: DeletionReauth = typeof reauth === 'string' || reauth === undefined ? { password: reauth } : reauth;
    const seller: any = await this.r.sellerModel.findById(sellerId);
    if (!seller || seller.isDelete) throw new NotFoundException('Seller not found');
    await this.assertReauth(seller, creds);
    return this.schedule(seller, ip, 'password_or_social');
  }

  private async assertReauth(seller: any, creds: DeletionReauth) {
    if (creds.authProvider || creds.socialId || creds.token) {
      if (!['google', 'apple'].includes(String(creds.authProvider)) || !creds.socialId || !creds.token || !this.auth) {
        throw new ForbiddenException({ statusCode: 403, code: 'INVALID_REAUTH', message: 'Sign-in confirmation failed' });
      }
      let verifiedEmail: string | null;
      try {
        verifiedEmail = await this.auth.verifyProviderIdentity(creds.authProvider!, creds.socialId, creds.token);
      } catch {
        throw new ForbiddenException({ statusCode: 403, code: 'INVALID_REAUTH', message: 'Sign-in confirmation failed' });
      }
      const sameIdentity = seller.providerId && seller.providerId === creds.socialId && seller.authProvider === creds.authProvider;
      const sameEmail = !!verifiedEmail && verifiedEmail === String(seller.email ?? '').toLowerCase();
      if (!sameIdentity && !sameEmail) {
        throw new ForbiddenException({ statusCode: 403, code: 'INVALID_REAUTH', message: 'That account does not match the one you are deleting' });
      }
      return;
    }
    if (!seller.password) {
      throw new ForbiddenException({ statusCode: 403, code: 'INVALID_REAUTH', message: 'This account has no password. Confirm with Google or Apple sign-in instead.' });
    }
    if (!creds.password || !(await bcrypt.compare(creds.password, seller.password))) {
      throw new ForbiddenException({ statusCode: 403, code: 'INVALID_PASSWORD', message: 'Password is incorrect' });
    }
  }

  /** Signed-out web flow, step 1: mail a code. ALWAYS answers the same way — never reveals whether the email has an account. */
  async requestPublicOtp(email: string) {
    const normalized = String(email ?? '').trim().toLowerCase();
    const seller: any = normalized ? await this.r.sellerModel.findOne({ email: normalized }) : null;
    if (seller && !seller.isDelete && seller.status === 'active') {
      const issuedAt = seller.otpExpiresAt ? new Date(seller.otpExpiresAt).getTime() - OTP_TTL_MS : 0;
      if (Date.now() - issuedAt >= OTP_RESEND_COOLDOWN_MS) {
        const otp = generateOtp();
        seller.otp = otp; seller.otpAttempts = 0; seller.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
        await seller.save();
        try { await this.otpService?.sendOtp(seller.email, otp); }
        catch (e: any) { this.logger.error(`deletion OTP mail failed: ${e?.message}`); }
      }
    }
    return { success: true, message: GENERIC_OTP_MESSAGE };
  }

  /** Signed-out web flow, step 2: the code proves control of the mailbox; then the same rules as the in-app request apply. */
  async confirmPublic(email: string, otp: string, ip?: string) {
    const normalized = String(email ?? '').trim().toLowerCase();
    const seller: any = normalized ? await this.r.sellerModel.findOne({ email: normalized }) : null;
    if (!seller || seller.isDelete || seller.status !== 'active') throw new UnauthorizedException('Invalid or expired code');
    await assertOtpAttempt(this.r.sellerModel, seller._id, otp);
    if (!seller.otpExpiresAt || new Date() > new Date(seller.otpExpiresAt)) throw new UnauthorizedException('Invalid or expired code');
    const res: any = await this.schedule(seller, ip, 'email_otp');
    await this.r.sellerModel.updateOne({ _id: seller._id }, { $set: { otp: null, otpExpiresAt: null, otpAttempts: 0 } });
    return { ...res, hint: 'To keep your account, sign in again before the scheduled date and cancel the deletion.' };
  }

  /** The rules every route shares: open-shift block, pending state, revocations, suspension, audit. */
  private async schedule(seller: any, ip: string | undefined, via: string) {
    const sellerId = String(seller._id);
    if (seller.status === 'pending_deletion') return this.status(sellerId);

    const stores: any[] = await this.r.storeModel.find({ sellerId, isDelete: false }).select('_id').lean();
    const storeIds = stores.map((s) => String(s._id));
    if (storeIds.length && await this.r.registerSessionModel.exists({ storeId: { $in: storeIds }, status: 'open' })) {
      throw new BadRequestException({ statusCode: 400, code: 'ACCOUNT_HAS_OPEN_SESSIONS', message: 'Close every open register shift before deleting the account.' });
    }

    const now = new Date();
    const scheduled = new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
    seller.status = 'pending_deletion';
    seller.deletionRequestedAt = now;
    seller.deletionScheduledFor = scheduled;
    seller.tokenVersion = (seller.tokenVersion ?? 0) + 1; // every owner session is revoked right now
    await seller.save();

    // Storefront and POS go dark; every registered device stops working; every PIN session ends.
    await this.r.storeModel.updateMany({ _id: { $in: storeIds } }, { $set: { status: 'suspended' } });
    await this.r.posDeviceModel.updateMany({ storeId: { $in: storeIds }, status: 'active' }, { $set: { status: 'revoked', revokedAt: now, revokedBy: 'account_deletion' } });
    const employees: any[] = await this.r.employeeModel.find({ storeId: { $in: storeIds }, isDelete: false }).select('_id').lean();
    for (const e of employees) await this.revocations?.revokeEmployee(String(e._id));
    for (const storeId of storeIds) {
      await this.r.posAuditLogModel.create({ storeId, employeeId: null, action: 'account_deletion_requested', targetId: sellerId, targetType: 'seller', metadata: { scheduledFor: scheduled, ip: ip ?? null, via } }).catch(() => {});
    }
    return { success: true, message: `Account scheduled for deletion on ${scheduled.toISOString().slice(0, 10)}. You can cancel until then.`, data: { scheduledFor: scheduled, graceDays: DELETION_GRACE_DAYS } };
  }

  /** Within the grace period only (a purged account cannot sign in, so cannot call this). Devices stay revoked — register them again. */
  async cancel(sellerId: string) {
    const seller: any = await this.r.sellerModel.findById(sellerId);
    if (!seller || seller.status !== 'pending_deletion') throw new BadRequestException('No deletion is pending for this account');
    seller.status = 'active';
    seller.deletionRequestedAt = null;
    seller.deletionScheduledFor = null;
    await seller.save();
    await this.r.storeModel.updateMany({ sellerId, isDelete: false, status: 'suspended' }, { $set: { status: 'active' } });
    return { success: true, message: 'Account deletion cancelled. Set your POS devices up again.' };
  }

  /** Cron entry: purges every account whose grace period is over. Returns how many were purged. */
  async purgeDue(now: Date = new Date()): Promise<number> {
    const due: any[] = await this.r.sellerModel.find({ status: 'pending_deletion', deletionScheduledFor: { $lte: now } }).select('_id').lean();
    for (const s of due) {
      try { await this.purge(String(s._id), now); } catch (e: any) { this.logger.error(`purge ${s._id} failed: ${e?.message}`); }
    }
    return due.length;
  }

  async purge(sellerId: string, now: Date = new Date()) {
    const seller: any = await this.r.sellerModel.findById(sellerId);
    if (!seller) return;
    const stores: any[] = await this.r.storeModel.find({ sellerId }).select('_id').lean();
    const storeIds = stores.map((s) => String(s._id));

    // People in the books — the books themselves stay.
    await this.r.saleModel.updateMany({ storeId: { $in: storeIds }, customerName: { $ne: 'Walk-in' } }, { $set: { customerName: 'Deleted customer' } });
    await this.r.saleModel.updateMany({ storeId: { $in: storeIds } }, { $set: { customerId: null, notes: null, employeeName: 'Deleted employee' } });
    const employees: any[] = await this.r.employeeModel.find({ storeId: { $in: storeIds } }).select('_id').lean();
    for (const e of employees) {
      await this.r.employeeModel.collection.updateOne({ _id: e._id }, { $set: { name: 'Deleted employee', email: `deleted+${e._id}@deleted.invalid`, pin: null, isDelete: true, status: 'inactive', phone: null } });
    }
    await this.r.posDeviceModel.deleteMany({ storeId: { $in: storeIds } });
    await this.r.posSettingsModel.updateMany({ storeId: { $in: storeIds } }, { $set: { businessAddress: null, businessTaxId: null, receiptHeader: null, receiptFooter: null, businessName: null } });
    await this.r.storeModel.updateMany({ _id: { $in: storeIds } }, { $set: { isDelete: true, status: 'suspended' } });

    seller.name = 'Deleted account';
    seller.email = `deleted+${seller._id}@deleted.invalid`;
    seller.phone = null; seller.address = null; seller.password = null; seller.providerId = null; seller.authProvider = null;
    seller.profileImage = null; seller.fcmToken = null; seller.otp = null;
    seller.status = 'deleted'; seller.isDelete = true; seller.anonymizedAt = now;
    seller.tokenVersion = (seller.tokenVersion ?? 0) + 1;
    await seller.save();
    for (const storeId of storeIds) {
      await this.r.posAuditLogModel.create({ storeId, employeeId: null, action: 'account_purged', targetId: sellerId, targetType: 'seller', metadata: { employees: employees.length } }).catch(() => {});
    }
  }
}
