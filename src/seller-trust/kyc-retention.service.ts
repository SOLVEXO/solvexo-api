/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { UploadService } from '@/upload/upload.service';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { SellerTrustService } from './seller-trust.service';
import {
  DEFAULT_KYC_DRAFT_RETENTION_DAYS, DEFAULT_KYC_RETENTION_YEARS, EXPIRING_DRAFT_STATUSES,
  addYears, allKycFiles, closedStoreDue, expiredDraftDocs, type RetentionDoc,
} from './kyc-retention.util';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 500;

export interface RetentionResult { closedErased: number; draftsExpired: number; filesDeleted: number; failed: number }

/**
 * Daily clean-up of seller verification documents (private Cloudinary files) and the identity data next to them, so nothing is
 * kept for ever. The periods are admin settings (default 6 years after a store closed, 90 days for files that never reached
 * review) — see kyc-retention.util.ts for the exact rules. A file that cannot be deleted is left in place and retried the next
 * day: the database record is only cleared once its file is really gone.
 */
@Injectable()
export class KycRetentionService {
  private readonly logger = new Logger(KycRetentionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sellerTrust: SellerTrustService,
    private readonly upload: UploadService,
    private readonly notifications: NotificationsService,
  ) {}

  private get storeModel() { return this.db.repositories.storeModel; }

  /** Deletes one private file. true = gone (or already gone); false = the storage refused, retry tomorrow. */
  private async removeFile(file: RetentionDoc): Promise<boolean> {
    try {
      await this.upload.deletePrivateFile(file.publicId, file.resourceType ?? 'raw');
      return true;
    } catch (err: any) {
      this.logger.warn(`could not delete ${file.publicId}: ${err?.message}`);
      return false;
    }
  }

  async run(now = new Date()): Promise<RetentionResult> {
    const settings = await this.sellerTrust.getSettings();
    const years = settings.kycRetentionYears ?? DEFAULT_KYC_RETENTION_YEARS;
    const days = settings.kycDraftRetentionDays ?? DEFAULT_KYC_DRAFT_RETENTION_DAYS;
    const result: RetentionResult = { closedErased: 0, draftsExpired: 0, filesDeleted: 0, failed: 0 };
    await this.eraseClosedStores(years, now, result);
    await this.expireDrafts(days, now, result);
    return result;
  }

  /** Closed stores: erase files + identity data once the retention period (counted from the closing date) is over. */
  private async eraseClosedStores(years: number, now: Date, result: RetentionResult) {
    const cutoff = addYears(now, -years);
    const stores: any[] = await this.storeModel.find({
      isDelete: true,
      'verification.purgedAt': null,
      $or: [
        { 'verification.submitted': { $ne: true } }, // never went to review: nothing to keep
        { verificationClosedAt: { $lte: cutoff } },
        { verificationClosedAt: null, updatedAt: { $lte: cutoff } }, // older rows without a closing date
      ],
    }).select('+verification verificationClosedAt updatedAt createdAt').limit(BATCH).lean();

    for (const store of stores) {
      if (!closedStoreDue(store, years, now)) continue;
      const files = allKycFiles(store.verification);
      let failed = 0;
      for (const f of files) { if (await this.removeFile(f)) result.filesDeleted++; else failed++; }
      if (failed) { result.failed += failed; continue; } // keep the record, retry tomorrow

      await this.storeModel.updateOne({ _id: store._id }, {
        $set: {
          'verification.documents': [], 'verification.change': null, 'verification.consent': null,
          'verification.legalBusinessName': null, 'verification.registrationNumber': null, 'verification.taxId': null,
          'verification.strn': null, 'verification.cnicNumber': null, 'verification.businessAddress': null,
          'verification.authorizedContact': {}, 'verification.purgedAt': now,
        },
        $push: { 'verification.history': { action: 'retention_erased', note: `Identity data and ${files.length} file(s) erased after the retention period`, actorId: null, actorRole: 'admin', at: now } },
      });
      result.closedErased++;
    }
  }

  /** Open stores: files that never reached review, or whose review ended without a fix, expire after `days`. */
  private async expireDrafts(days: number, now: Date, result: RetentionResult) {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const stores: any[] = await this.storeModel.find({
      isDelete: false,
      $or: [
        { verificationStatus: { $in: ['not_started', null] }, 'verification.documents.uploadedAt': { $lte: cutoff } },
        { verificationStatus: { $in: EXPIRING_DRAFT_STATUSES.filter((s) => s !== 'not_started') }, reviewedAt: { $lte: cutoff }, 'verification.documents.0': { $exists: true } },
      ],
    }).select('+verification name sellerId verificationStatus reviewedAt').limit(BATCH).lean();

    for (const store of stores) {
      const expired = expiredDraftDocs(store, days, now);
      if (!expired.length) continue;
      const gone: RetentionDoc[] = [];
      for (const f of expired) { if (await this.removeFile(f)) { gone.push(f); result.filesDeleted++; } else result.failed++; }
      if (!gone.length) continue;

      await this.storeModel.updateOne({ _id: store._id }, {
        $pull: { 'verification.documents': { publicId: { $in: gone.map((g) => g.publicId) } } },
        $push: { 'verification.history': { action: 'documents_expired', note: gone.map((g) => g.type).filter(Boolean).join(', ') || null, actorId: null, actorRole: 'admin', at: now } },
      });
      result.draftsExpired++;
      await this.notifications.notify({
        recipientId: store.sellerId, recipientRole: 'seller', storeId: String(store._id),
        type: NOTIFICATION_TYPES.VERIFICATION_REMINDER,
        title: 'Your uploaded documents were removed',
        body: `For your privacy, Solvexo deletes verification documents that were not submitted for review within ${days} days. Your other details are kept. Upload the documents again when you verify "${store.name}".`,
        data: { storeId: String(store._id), link: `/store/${String(store._id)}/settings/verification` },
      }).catch(() => {});
    }
  }
}
