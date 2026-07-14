/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import { ComparablePricingStats, PricingDataAdapter } from './ai-provider.interfaces';
import { TextGenerationService } from './text-generation.service';

/** Below this many comparable listings the stats are flagged low-confidence. */
const MIN_TRUSTED_SAMPLE = 3;

/**
 * PricingDataAdapter — the numbers sellers should trust come from OUR OWN
 * listings database (median/percentiles of active same-category listings),
 * computed statistically. The LLM never produces the primary numbers.
 *
 * Claude (+ web search) contributes only:
 *  - `getExternalMarketNote` — an optional, clearly-labeled rough web signal,
 *    surfaced separately and never blended into the suggested price. Gated
 *    behind AI_PRICING_WEB_CHECK=true and silently skipped on any failure.
 *  - (in AiStudioService) narrating the computed numbers into `explanation`.
 */
@Injectable()
export class PricingDataService implements PricingDataAdapter {
  private readonly logger = new Logger(PricingDataService.name);
  private readonly webCheckEnabled: boolean;

  constructor(
    private readonly db: DatabaseService,
    private readonly textGeneration: TextGenerationService,
    config: ConfigService,
  ) {
    this.webCheckEnabled = config.get<string>('AI_PRICING_WEB_CHECK') === 'true';
  }

  async getComparableStats(params: {
    categoryId: string;
    productType?: string;
    excludeProductId?: string;
  }): Promise<ComparablePricingStats> {
    const productFilter: Record<string, any> = {
      categoryId: params.categoryId,
      status: 'active',
      isDelete: false,
    };
    if (params.productType) productFilter.productType = params.productType;
    if (params.excludeProductId) productFilter._id = { $ne: params.excludeProductId };

    const products = await this.db.repositories.productModel
      .find(productFilter).select('_id').limit(500).lean();
    const productIds = products.map((p: any) => p._id.toString());
    if (productIds.length === 0) return this.emptyStats();

    const variants = await this.db.repositories.productVariantModel
      .find({ productId: { $in: productIds }, price: { $gt: 0 } })
      .select('productId price').lean();

    // One representative price per product (its cheapest variant) so a product
    // with many variants doesn't dominate the distribution.
    const minPerProduct = new Map<string, number>();
    for (const v of variants as any[]) {
      const pid = v.productId?.toString();
      if (!pid) continue;
      const current = minPerProduct.get(pid);
      if (current === undefined || v.price < current) minPerProduct.set(pid, v.price);
    }

    const prices = [...minPerProduct.values()].sort((a, b) => a - b);
    if (prices.length === 0) return this.emptyStats();

    return {
      sampleSize: prices.length,
      minPrice: prices[0],
      maxPrice: prices[prices.length - 1],
      medianPrice: this.percentile(prices, 0.5),
      p25Price: this.percentile(prices, 0.25),
      p75Price: this.percentile(prices, 0.75),
      lowConfidence: prices.length < MIN_TRUSTED_SAMPLE,
    };
  }

  async getExternalMarketNote(params: {
    productName: string;
    categoryName?: string;
  }): Promise<string | null> {
    if (!this.webCheckEnabled || this.textGeneration.providerName !== 'claude') return null;
    try {
      const result = await this.textGeneration.generate({
        tier: 'advanced',
        webSearch: { maxUses: 2 },
        maxTokens: 512,
        system: 'You are a market researcher. Use web search to find typical current retail prices. Reply with 2-3 plain sentences. If you cannot find reliable pricing, say so honestly instead of guessing.',
        prompt: `What do products like "${params.productName}"${params.categoryName ? ` (category: ${params.categoryName})` : ''} typically sell for online right now? Mention the rough price range you found and where.`,
      });
      const note = result.text.trim();
      return note ? `General web signal (not a same-platform comparable): ${note}` : null;
    } catch (error) {
      this.logger.warn(`External market check skipped: ${(error as Error).message}`);
      return null;
    }
  }

  private emptyStats(): ComparablePricingStats {
    return { sampleSize: 0, minPrice: null, maxPrice: null, medianPrice: null, p25Price: null, p75Price: null, lowConfidence: true };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 1) return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    return Math.round(value * 100) / 100;
  }
}
