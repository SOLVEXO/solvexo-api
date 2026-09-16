/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';

/**
 * Phase 5 — Product Tracking Foundation.
 *
 * Records one real product-detail-page view per call, subject to a dedup
 * window (see DEDUP_WINDOW_MS) so a page refresh or a re-opened tab from the
 * same visitor doesn't inflate the count into something that no longer
 * reflects real distinct interest. This is a fire-and-forget analytics
 * beacon — it must never throw for a caller that simply has nothing useful
 * to record (unknown/deleted product, no identity), only for a genuinely
 * malformed request.
 */
@Injectable()
export class ProductViewsService {
  /** A view from the same identity on the same product inside this window
   *  counts as the same browsing session, not a second distinct view. */
  static readonly DEDUP_WINDOW_MS = 30 * 60 * 1000;

  constructor(private readonly databaseService: DatabaseService) {}

  private get r() {
    return this.databaseService.repositories;
  }

  async recordView(productId: string, identity: { userId?: string | null; anonId?: string | null }) {
    if (!productId || typeof productId !== 'string') {
      throw new BadRequestException('productId is required');
    }

    // A logged-in buyer is identified by userId; an anonymous visitor by their
    // own client-generated anonId. Never both, never neither treated as "Guest".
    const userId = identity.userId || null;
    const anonId = userId ? null : identity.anonId || null;
    if (!userId && !anonId) {
      throw new BadRequestException('userId or anonId is required to record a view');
    }

    // storeId/sellerId are ALWAYS derived from the product itself, never from
    // the request body — see the schema's own doc comment on why.
    const product = await this.r.productModel
      .findOne({ _id: productId, isDelete: false })
      .select('sellerId storeId')
      .lean();
    // Unknown/deleted product: nothing real to attribute this view to. A
    // fire-and-forget beacon reports success rather than erroring the page.
    if (!product) return { success: true, recorded: false };

    const now = new Date();
    const dedupSince = new Date(now.getTime() - ProductViewsService.DEDUP_WINDOW_MS);
    const identityMatch = userId ? { userId } : { anonId };

    const recent = await this.r.productViewModel
      .findOne({ productId, ...identityMatch, viewedAt: { $gte: dedupSince } })
      .select('_id')
      .lean();
    if (recent) return { success: true, recorded: false };

    await this.r.productViewModel.create({
      productId,
      storeId: (product as any).storeId,
      sellerId: (product as any).sellerId,
      userId,
      anonId,
      viewedAt: now,
    });

    // Product.viewCount/lastViewedAt already existed on the schema (dead
    // fields until now) — this is their first real writer.
    await this.r.productModel.updateOne({ _id: productId }, { $inc: { viewCount: 1 }, $set: { lastViewedAt: now } });

    return { success: true, recorded: true };
  }
}
