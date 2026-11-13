/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { AiCreditsService } from '@/platform-plans/ai-credits.service';
import { QUEUE_NAMES, SEO_AI_GENERATE_BULK_JOB } from '@/queues/queue.constants';
import { SeoContentService } from './seo-content.service';
import { AnthropicSeoAiProvider } from '../providers/anthropic-seo-ai.provider';
import { PlatformSeoService } from './platform-seo-settings.service';

export const AI_SEO_SUGGESTION_CREDIT_COST = 5;

/**
 * Orchestrates `ISeoAiProvider` (currently `AnthropicSeoAiProvider`, selected
 * structurally here rather than via an `AI_SEO_PROVIDER` env switch since
 * there's only one implementation today — swapping providers later means
 * changing this one constructor injection, not any call site). Every
 * generation: verifies store ownership + `seoAiSuggestionsAllowed`
 * entitlement + the platform-wide AI SEO kill switch, deducts
 * `AiCreditsWallet` credits, calls the provider, writes the result via
 * `SeoContentService.applySeoSuggestion`, and logs a `SeoAiSuggestionLog` row.
 *
 * Category entities are intentionally out of scope here — categories are
 * admin-curated (see master doc §5.2) and have no per-store credit wallet to
 * charge against; AI suggestions only apply to seller-owned products/stores.
 */
@Injectable()
export class SeoAiService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly entitlements: EntitlementsService,
    private readonly aiCredits: AiCreditsService,
    private readonly seoContent: SeoContentService,
    private readonly aiProvider: AnthropicSeoAiProvider,
    private readonly platformSeoService: PlatformSeoService,
    @InjectQueue(QUEUE_NAMES.SEO_AI) private readonly seoAiQueue: Queue,
  ) {}

  /**
   * `options.apply` (default false): when false the suggestion is only PREVIEWED - nothing on the product/store changes and the
   * seller decides with `accept()`; the bulk job passes `apply: true` (it exists to fill many products in one go).
   */
  async generate(
    entityType: 'product' | 'category' | 'store',
    entityId: string,
    sellerId: string,
    actor: { id: string; name?: string; role?: string },
    options: { apply?: boolean } = {},
  ) {
    const apply = options.apply === true;
    if (entityType === 'category') {
      throw new BadRequestException('AI SEO suggestions are not available for platform categories.');
    }

    const settings = await this.platformSeoService.getSettings();
    if (!settings.aiSeoEnabled) {
      throw new ForbiddenException('AI SEO is currently disabled platform-wide.');
    }

    const context = await this.seoContent.getEntityContext(entityType, entityId);
    if (context.sellerId !== sellerId) {
      throw new ForbiddenException('You do not own this resource.');
    }
    const storeId = context.storeId as string;

    await this.entitlements.assertFeatureAllowed(storeId, 'seoAiSuggestionsAllowed', 'AI-generated SEO suggestions');
    // No API key yet: refuse BEFORE touching the seller's credits.
    if (this.aiProvider.isConfigured === false) {
      throw new ServiceUnavailableException('AI SEO suggestions are not switched on yet. Nothing was charged.');
    }
    await this.aiCredits.deduct(storeId, sellerId, AI_SEO_SUGGESTION_CREDIT_COST, `AI SEO suggestion — ${entityType} ${entityId}`);

    let suggestion: Awaited<ReturnType<AnthropicSeoAiProvider['generateSuggestion']>>;
    try {
      suggestion = await this.aiProvider.generateSuggestion({
        entityType,
        name: context.name,
        description: context.description,
        categoryName: context.categoryName,
        storeName: context.storeName,
      });
      if (apply) await this.seoContent.applySeoSuggestion(entityType, entityId, suggestion, true);
    } catch (e) {
      // Credits are charged only for a suggestion that was really produced: give them back on any failure.
      await this.aiCredits.grant(storeId, sellerId, AI_SEO_SUGGESTION_CREDIT_COST, `Refund — AI SEO suggestion failed (${entityType} ${entityId})`).catch(() => undefined);
      throw e;
    }

    const log: any = await this.db.repositories.seoAiSuggestionLogModel.create({
      storeId, sellerId, entityType, entityId, suggestion, accepted: apply, creditsCost: AI_SEO_SUGGESTION_CREDIT_COST,
    });

    await this.activityLog.log({
      storeId,
      category: 'seo',
      action: 'seo_ai_suggestion_generated',
      description: `AI SEO suggestion generated for ${entityType} "${context.name}"${apply ? ' and applied' : ' (preview)'}`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: entityId, targetType: `${entityType}_seo`,
      metadata: { creditsCost: AI_SEO_SUGGESTION_CREDIT_COST, applied: apply },
    });

    return { ...suggestion, suggestionId: String(log._id), applied: apply };
  }

  /** Writes a PREVIEWED suggestion onto the product/store once the seller says "use this". Idempotent: a second call changes nothing. No credits are charged here. */
  async accept(
    storeId: string,
    suggestionId: string,
    actor: { id: string; name?: string; role?: string },
  ) {
    await this.entitlements.assertFeatureAllowed(storeId, 'seoAiSuggestionsAllowed', 'AI-generated SEO suggestions');
    if (!isValidObjectId(suggestionId)) throw new NotFoundException('Suggestion not found.');
    const model = this.db.repositories.seoAiSuggestionLogModel;
    const log: any = await model.findOne({ _id: suggestionId, storeId }).lean();
    if (!log) throw new NotFoundException('Suggestion not found.');
    const result = { applied: true, entityType: log.entityType as string, entityId: String(log.entityId) };
    if (log.accepted) return { ...result, alreadyApplied: true };

    const context = await this.seoContent.getEntityContext(log.entityType, String(log.entityId));
    if (context.storeId !== storeId) throw new ForbiddenException('This suggestion does not belong to your store.');

    // Claim first, so two clicks cannot both write; put the claim back if the write fails.
    const claim = await model.findOneAndUpdate({ _id: suggestionId, storeId, accepted: false }, { $set: { accepted: true } });
    if (!claim) return { ...result, alreadyApplied: true };
    try {
      await this.seoContent.applySeoSuggestion(log.entityType, String(log.entityId), log.suggestion, true);
    } catch (e) {
      await model.updateOne({ _id: suggestionId }, { $set: { accepted: false } });
      throw e;
    }

    await this.activityLog.log({
      storeId, category: 'seo', action: 'seo_ai_suggestion_accepted',
      description: `AI SEO suggestion applied to ${log.entityType} "${context.name}"`,
      actorId: actor.id, actorName: actor.name ?? null, actorRole: actor.role ?? null,
      targetId: String(log.entityId), targetType: `${log.entityType}_seo`,
    });
    return { ...result, alreadyApplied: false };
  }

  async getSuggestionHistory(storeId: string, query: { page?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const filter = { storeId };

    const [items, total] = await Promise.all([
      this.db.repositories.seoAiSuggestionLogModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.db.repositories.seoAiSuggestionLogModel.countDocuments(filter),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** Enqueues bulk generation — never runs inline, since generating for many entities can take real time and must gracefully stop when the credit wallet runs out. */
  async enqueueBulkGenerate(
    entityType: 'product' | 'category' | 'store',
    entityIds: string[],
    storeId: string,
    sellerId: string,
    actor: { id: string; name?: string; role?: string },
  ) {
    if (entityType === 'category') {
      throw new BadRequestException('AI SEO suggestions are not available for platform categories.');
    }
    await this.entitlements.assertFeatureAllowed(storeId, 'seoAiSuggestionsAllowed', 'AI-generated SEO suggestions');

    const job = await this.seoAiQueue.add(SEO_AI_GENERATE_BULK_JOB, {
      entityType, entityIds, storeId, sellerId, actor,
    });
    return { queued: true, jobId: job.id };
  }
}
