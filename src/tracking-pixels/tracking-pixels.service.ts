/* eslint-disable prettier/prettier */
import { Injectable, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { UpdateTrackingPixelSettingsDto } from './dto/update-tracking-pixel-settings.dto';

const FIELDS = ['facebookPixelId', 'googleAnalyticsId', 'googleAdsId', 'googleAdsConversionLabel', 'tiktokPixelId'] as const;
const DEFAULTS = { facebookPixelId: null, googleAnalyticsId: null, googleAdsId: null, googleAdsConversionLabel: null, tiktokPixelId: null };

/** Ad-platform pixel connections — the Shopify "Online Store → Preferences
 *  → Pixels" equivalent. Solvexo holds no ad-platform credential of its
 *  own here; a seller pastes ids straight out of their own Meta/Google/
 *  TikTok ad accounts, and this module's whole job is to store those ids
 *  and serve them back to the storefront (see getPublicSettings) so it can
 *  load each platform's real tracking script and fire real PageView/
 *  AddToCart/Purchase events — see the frontend's `trackingPixels.ts`. */
@Injectable()
export class TrackingPixelsService {
  constructor(private readonly db: DatabaseService) {}

  private get r() {
    return this.db.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async getOrDefaultSettings(storeId: string) {
    const existing = await this.r.trackingPixelSettingsModel.findOne({ storeId, isDelete: false }).lean();
    return existing ?? { storeId, ...DEFAULTS, _id: null };
  }

  async getSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const settings = await this.getOrDefaultSettings(storeId);
    return { success: true, message: 'Tracking pixel settings', data: settings };
  }

  async updateSettings(sellerId: string, storeId: string, dto: UpdateTrackingPixelSettingsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);

    // '' means "clear this one" — normalize to null so a blanked field
    // actually stops that platform's script from loading (see the schema's
    // doc comment: absent/null is the "off" state, not an empty string).
    const normalized: Record<string, string | null> = {};
    for (const field of FIELDS) {
      if (dto[field] !== undefined) normalized[field] = dto[field]?.trim() || null;
    }

    const settings = await this.r.trackingPixelSettingsModel.findOneAndUpdate(
      { storeId },
      { $set: { storeId, ...normalized }, $setOnInsert: DEFAULTS },
      { new: true, upsert: true },
    );
    return { success: true, message: 'Tracking pixel settings updated', data: settings };
  }

  /** Public — hit by every storefront page load (see StorefrontLayout) to
   *  know which scripts to inject. Deliberately unauthenticated: these ids
   *  are not secrets, they end up in the page's own rendered output the
   *  moment a script loads anyway. */
  async getPublicSettings(storeId: string) {
    const settings = await this.getOrDefaultSettings(storeId);
    return {
      success: true,
      data: {
        facebookPixelId: settings.facebookPixelId,
        googleAnalyticsId: settings.googleAnalyticsId,
        googleAdsId: settings.googleAdsId,
        googleAdsConversionLabel: settings.googleAdsConversionLabel,
        tiktokPixelId: settings.tiktokPixelId,
      },
    };
  }
}
