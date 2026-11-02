/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '@/database/databaseservice';
import { PosTokenRevocationService } from '../pos/pos-token-revocation.service';

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
  ) {}

  private get r() { return this.databaseService.repositories; }

  async status(sellerId: string) {
    const s: any = await this.r.sellerModel.findById(sellerId).select('status deletionRequestedAt deletionScheduledFor').lean();
    if (!s) throw new NotFoundException('Seller not found');
    return { success: true, data: { pending: s.status === 'pending_deletion', requestedAt: s.deletionRequestedAt ?? null, scheduledFor: s.deletionScheduledFor ?? null, graceDays: DELETION_GRACE_DAYS } };
  }

  async request(sellerId: string, password: string | undefined, ip?: string) {
    const seller: any = await this.r.sellerModel.findById(sellerId);
    if (!seller || seller.isDelete) throw new NotFoundException('Seller not found');
    if (!seller.password) {
      throw new BadRequestException({ statusCode: 400, code: 'PASSWORD_REQUIRED_FOR_DELETION', message: 'This account signs in with a social login and has no password to confirm with. Delete it from the web (account settings) or set a password first.' });
    }
    if (!password || !(await bcrypt.compare(password, seller.password))) {
      throw new ForbiddenException({ statusCode: 403, code: 'INVALID_PASSWORD', message: 'Password is incorrect' });
    }
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
      await this.r.posAuditLogModel.create({ storeId, employeeId: null, action: 'account_deletion_requested', targetId: sellerId, targetType: 'seller', metadata: { scheduledFor: scheduled, ip: ip ?? null } }).catch(() => {});
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
