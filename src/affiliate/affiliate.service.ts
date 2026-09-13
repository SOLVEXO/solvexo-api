/* eslint-disable prettier/prettier */
import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { randomBytes } from 'crypto';
import { CreateAffiliateDto } from './dto/create-affiliate.dto';
import { UpdateAffiliateDto } from './dto/update-affiliate.dto';
import { UpdateAffiliateProgramDto } from './dto/update-affiliate-program.dto';

const PLATFORM_ORIGIN = 'https://solvexo.store';
const DEFAULT_PROGRAM = { enabled: false, commissionType: 'percentage' as const, commissionValue: 10, cookieWindowDays: 30 };

/** Seller-run affiliate/referral program — the Shopify-affiliate-app
 *  equivalent (Refersion/UpPromote style): a seller adds affiliates
 *  directly (no public apply/approve workflow), each gets a unique
 *  referral link, a real click on it is tracked, and — the moment a buyer
 *  who came through that link actually completes an order containing this
 *  store's items — a real commission is computed and recorded, not just a
 *  database stub. See AffiliateReferral's own doc comment for the one
 *  deliberate scope cut (no automatic refund-reversal — payout is a manual
 *  seller action either way). */
@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async generateUniqueReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomBytes(5).toString('hex').toUpperCase(); // 10 chars
      const exists = await this.r.affiliateModel.findOne({ referralCode: code }).select('_id').lean();
      if (!exists) return code;
    }
    // Astronomically unlikely to ever reach here (10 hex chars = 16^10
    // possibilities), but never loop forever or silently reuse a code.
    throw new BadRequestException('Could not generate a unique referral code — please try again');
  }

  // ── Program settings ──────────────────────────────────────────────────────

  private async getOrDefaultProgram(storeId: string) {
    const existing = await this.r.affiliateProgramModel.findOne({ storeId, isDelete: false }).lean();
    return existing ?? { storeId, ...DEFAULT_PROGRAM, _id: null };
  }

  async getProgramSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const program = await this.getOrDefaultProgram(storeId);
    return { success: true, message: 'Affiliate program settings', data: program };
  }

  async updateProgramSettings(sellerId: string, storeId: string, dto: UpdateAffiliateProgramDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const program = await this.r.affiliateProgramModel.findOneAndUpdate(
      { storeId },
      { $set: { storeId, ...dto }, $setOnInsert: DEFAULT_PROGRAM },
      { new: true, upsert: true },
    );
    return { success: true, message: 'Affiliate program updated', data: program };
  }

  // ── Affiliates (seller manages directly — no public apply flow) ─────────

  async createAffiliate(sellerId: string, storeId: string, dto: CreateAffiliateDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const email = dto.email.toLowerCase().trim();

    const existing = await this.r.affiliateModel.findOne({ storeId, email, isDelete: false }).lean();
    if (existing) throw new BadRequestException('This email is already an affiliate for this store');

    const matchingUser = await this.r.userModel.findOne({ email }).select('_id').lean();
    const referralCode = await this.generateUniqueReferralCode();

    const affiliate = await this.r.affiliateModel.create({
      storeId,
      email,
      name: dto.name,
      userId: (matchingUser as any)?._id ? String((matchingUser as any)._id) : null,
      referralCode,
      commissionType: dto.commissionType ?? null,
      commissionValue: dto.commissionValue ?? null,
    });
    return { success: true, message: 'Affiliate added', data: this.toApiShape(affiliate) };
  }

  private toApiShape(affiliate: any) {
    return {
      ...(affiliate.toObject ? affiliate.toObject() : affiliate),
      referralLink: `${PLATFORM_ORIGIN}/api/affiliate/r/${affiliate.referralCode}`,
    };
  }

  async listAffiliates(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 50));
    const filter: any = { storeId, isDelete: false };

    const [affiliates, total] = await Promise.all([
      this.r.affiliateModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.affiliateModel.countDocuments(filter),
    ]);
    const withLinks = affiliates.map((a: any) => ({ ...a, referralLink: `${PLATFORM_ORIGIN}/api/affiliate/r/${a.referralCode}` }));
    return { success: true, message: 'Affiliates', data: { affiliates: withLinks, total, page, limit } };
  }

  private async getOwnedAffiliate(storeId: string, sellerId: string, affiliateId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const affiliate = await this.r.affiliateModel.findOne({ _id: affiliateId, storeId, isDelete: false });
    if (!affiliate) throw new NotFoundException('Affiliate not found');
    return affiliate;
  }

  async updateAffiliate(sellerId: string, storeId: string, affiliateId: string, dto: UpdateAffiliateDto) {
    const affiliate = await this.getOwnedAffiliate(storeId, sellerId, affiliateId);
    Object.assign(affiliate, dto);
    await affiliate.save();
    return { success: true, message: 'Affiliate updated', data: this.toApiShape(affiliate) };
  }

  async removeAffiliate(sellerId: string, storeId: string, affiliateId: string) {
    const affiliate = await this.getOwnedAffiliate(storeId, sellerId, affiliateId);
    affiliate.isDelete = true;
    affiliate.isActive = false;
    await affiliate.save();
    return { success: true, message: 'Affiliate removed' };
  }

  // ── Referrals / payouts ───────────────────────────────────────────────────

  async listReferrals(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 50));
    const filter: any = { storeId };
    if (query.affiliateId) filter.affiliateId = query.affiliateId;
    if (query.status) filter.status = query.status;

    const [referrals, total] = await Promise.all([
      this.r.affiliateReferralModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.affiliateReferralModel.countDocuments(filter),
    ]);

    const affiliateIds = [...new Set(referrals.map((r: any) => r.affiliateId))];
    const affiliates = affiliateIds.length
      ? await this.r.affiliateModel.find({ _id: { $in: affiliateIds } }).select('name email').lean()
      : [];
    const affiliateMap = Object.fromEntries(affiliates.map((a: any) => [a._id.toString(), a]));

    const items = referrals.map((r: any) => ({
      ...r,
      affiliateName: affiliateMap[r.affiliateId]?.name ?? 'Unknown',
      affiliateEmail: affiliateMap[r.affiliateId]?.email ?? null,
    }));

    return { success: true, message: 'Referrals', data: { referrals: items, total, page, limit } };
  }

  async getStats(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const [affiliateCount, totals, pendingAgg] = await Promise.all([
      this.r.affiliateModel.countDocuments({ storeId, isDelete: false }),
      this.r.affiliateModel.aggregate([
        { $match: { storeId, isDelete: false } },
        { $group: { _id: null, clicks: { $sum: '$totalClicks' }, conversions: { $sum: '$totalConversions' }, earnings: { $sum: '$totalEarningsUSD' }, paid: { $sum: '$totalPaidUSD' } } },
      ]),
      this.r.affiliateReferralModel.aggregate([
        { $match: { storeId, status: 'pending' } },
        { $group: { _id: null, owed: { $sum: '$commissionUSD' } } },
      ]),
    ]);
    const t = totals[0] ?? { clicks: 0, conversions: 0, earnings: 0, paid: 0 };
    const owed = pendingAgg[0]?.owed ?? 0;

    return {
      success: true,
      data: {
        affiliateCount,
        totalClicks: t.clicks ?? 0,
        totalConversions: t.conversions ?? 0,
        totalEarningsUSD: this.round(t.earnings ?? 0),
        totalPaidUSD: this.round(t.paid ?? 0),
        totalOwedUSD: this.round(owed),
      },
    };
  }

  /** Marks every one of this affiliate's still-`pending` referrals as
   *  `paid` in one go — a deliberate manual action (there is no automatic
   *  payout rail here, same as a seller's own Payout being seller-initiated
   *  elsewhere in the platform). */
  async payAffiliate(sellerId: string, storeId: string, affiliateId: string) {
    const affiliate = await this.getOwnedAffiliate(storeId, sellerId, affiliateId);
    const pending = await this.r.affiliateReferralModel.find({ affiliateId, storeId, status: 'pending' });
    if (pending.length === 0) return { success: true, message: 'Nothing owed', data: this.toApiShape(affiliate) };

    const totalPaid = pending.reduce((s, r: any) => s + r.commissionUSD, 0);
    const now = new Date();
    await this.r.affiliateReferralModel.updateMany(
      { _id: { $in: pending.map((r: any) => r._id) } },
      { $set: { status: 'paid', paidAt: now } },
    );
    affiliate.totalPaidUSD = this.round(affiliate.totalPaidUSD + totalPaid);
    await affiliate.save();

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'affiliate_paid',
      description: `Marked $${totalPaid.toFixed(2)} paid to affiliate "${affiliate.name}" (${pending.length} referral(s))`,
      actorRole: 'seller', targetId: affiliateId, targetType: 'affiliate',
    });

    return { success: true, message: `Marked $${totalPaid.toFixed(2)} paid`, data: this.toApiShape(affiliate) };
  }

  // ── Public click tracking ─────────────────────────────────────────────────

  /** Hit when someone clicks a shared referral link. Not gated on
   *  program.enabled — an affiliate's link should always at least count the
   *  click and get the visitor to the store; disabling the program only
   *  stops NEW commissions being earned (see recordConversion), it doesn't
   *  retroactively break existing links. */
  async trackClick(referralCode: string): Promise<string> {
    const affiliate = await this.r.affiliateModel.findOneAndUpdate(
      { referralCode, isDelete: false, isActive: true },
      { $inc: { totalClicks: 1 } },
    );
    if (!affiliate) return PLATFORM_ORIGIN;

    const store = await this.r.storeModel.findById(affiliate.storeId).select('slug').lean();
    const slug = (store as any)?.slug;
    return slug ? `${PLATFORM_ORIGIN}/store/${slug}?ref=${referralCode}` : `${PLATFORM_ORIGIN}?ref=${referralCode}`;
  }

  // ── Order-placement hook (called from PaymentService.createOrder) ───────

  /** A referral code belongs to ONE store's program, so on a multi-store
   *  cart only the sellerOrder(s) matching that store count toward the
   *  commission — never the whole cart's total (same store-scoping
   *  principle as coupon/gift-card discounts elsewhere in checkout). */
  async recordConversion(checkoutId: string, referralCode: string, createdOrders: any[]): Promise<void> {
    try {
      const affiliate = await this.r.affiliateModel.findOne({ referralCode, isDelete: false, isActive: true });
      if (!affiliate) return;

      const program = await this.getOrDefaultProgram(affiliate.storeId);
      if (!program.enabled) return;

      let storeRevenue = 0;
      let matchedOrderId: string | null = null;
      for (const order of createdOrders as any[]) {
        const so = (order.sellerOrders as any[]).find((s) => s.storeId === affiliate.storeId);
        if (so) {
          storeRevenue += so.subtotal;
          if (!matchedOrderId) matchedOrderId = order._id.toString();
        }
      }
      if (storeRevenue <= 0 || !matchedOrderId) return;

      const commissionType = affiliate.commissionType ?? program.commissionType;
      const commissionValue = affiliate.commissionValue ?? program.commissionValue;
      const commissionUSD = commissionType === 'percentage'
        ? this.round((storeRevenue * commissionValue) / 100)
        : this.round(Math.min(commissionValue, storeRevenue));
      if (commissionUSD <= 0) return;

      await this.r.affiliateReferralModel.create({
        storeId: affiliate.storeId,
        affiliateId: affiliate._id.toString(),
        checkoutId,
        orderId: matchedOrderId,
        orderRevenueUSD: this.round(storeRevenue),
        commissionUSD,
        status: 'pending',
      });

      affiliate.totalConversions += 1;
      affiliate.totalEarningsUSD = this.round(affiliate.totalEarningsUSD + commissionUSD);
      await affiliate.save();

      this.activityLogService.log({
        storeId: affiliate.storeId, category: 'marketing', action: 'affiliate_conversion',
        description: `Order ${matchedOrderId} attributed to affiliate "${affiliate.name}" — $${commissionUSD.toFixed(2)} commission`,
        actorRole: 'system', targetId: matchedOrderId, targetType: 'order',
      });
    } catch (e: any) {
      this.logger.error(`recordConversion: failed for referralCode ${referralCode}: ${e?.message}`);
    }
  }
}
