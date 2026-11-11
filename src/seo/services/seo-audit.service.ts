/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { QUEUE_NAMES, SEO_AUDIT_RUN_JOB } from '@/queues/queue.constants';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { PlatformSeoService } from './platform-seo-settings.service';
import { StoreSeoService } from './store-seo.service';

interface AuditIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  entityType?: 'product' | 'category' | 'store' | null;
  entityId?: string | null;
}

const SEVERITY_WEIGHT: Record<string, number> = { info: 1, warning: 3, error: 6 };

/**
 * Fixed, code-defined audit checks whose *thresholds* come from
 * `PlatformSeoSettings.rules` — see architecture plan Refinement #3 (NOT a
 * generic data-driven rule engine; the check logic itself is code, only the
 * numbers are configurable). Several checks are honest approximations given
 * what this codebase's data model actually stores (no per-image alt-text
 * field exists, for instance) — documented inline rather than overclaiming.
 */
@Injectable()
export class SeoAuditService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
    private readonly platformSeoService: PlatformSeoService,
    private readonly storeSeoService: StoreSeoService,
    private readonly entitlements: EntitlementsService,
    @InjectQueue(QUEUE_NAMES.SEO_AUDIT) private readonly auditQueue: Queue,
  ) {}

  async enqueueRun(storeId: string): Promise<{ queued: true }> {
    await this.auditQueue.add(SEO_AUDIT_RUN_JOB, { storeId });
    return { queued: true };
  }

  /** Called by the daily `runScheduledSeoAudits` cron — only for stores whose platform plan includes `advancedSeoToolsAllowed`. */
  async enqueueScheduledRuns(): Promise<{ queued: number }> {
    const activeStores = await this.db.repositories.storeModel.find({ status: 'active', isDelete: false }).select('_id').lean();
    let queued = 0;
    for (const store of activeStores as any[]) {
      const limits = await this.entitlements.getLimits(store._id.toString());
      if (limits.advancedSeoToolsAllowed) {
        await this.enqueueRun(store._id.toString());
        queued++;
      }
    }
    return { queued };
  }

  async getLatest(storeId: string) {
    const latest = await this.db.repositories.seoAuditResultModel.findOne({ storeId }).sort({ runAt: -1 }).lean();
    if (!latest) throw new NotFoundException('No audit has been run for this store yet — run one first.');
    return latest;
  }

  async getHistory(storeId: string, query: { page?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
    const filter = { storeId };

    const [items, total] = await Promise.all([
      this.db.repositories.seoAuditResultModel.find(filter).select('score runAt checklistCompletionPercent').sort({ runAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.db.repositories.seoAuditResultModel.countDocuments(filter),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /** Invoked by SeoAuditProcessor — runs every enabled built-in check against the store's products + store meta, scores the result, and persists it. */
  async run(storeId: string) {
    const [settings, store, products, checklist] = await Promise.all([
      this.platformSeoService.getSettings(),
      this.db.repositories.storeModel.findById(storeId).lean(),
      this.db.repositories.productModel.find({ storeId, isDelete: false }).lean(),
      this.storeSeoService.getChecklist(storeId),
    ]);
    if (!store) throw new NotFoundException('Store not found.');

    const enabledRules = new Map(settings.rules?.map((r: any) => [r.code, r]) ?? []);
    const isEnabled = (code: string) => (enabledRules.get(code))?.enabled ?? true;
    const threshold = (code: string, key: string, fallback: number) => (enabledRules.get(code))?.thresholds?.[key] ?? fallback;
    const severityOf = (code: string, fallback: 'info' | 'warning' | 'error') => (enabledRules.get(code))?.severity ?? fallback;

    const issues: AuditIssue[] = [];
    const titleCounts = new Map<string, string[]>(); // for duplicate_meta

    // The storefront does not leave a page without a title or description: it walks product -> category -> store -> platform
    // template -> "Name – Store" (see SeoResolutionService). The audit judges the title/description a visitor and Google actually
    // get, so a page that is fine on the automatic text is not reported as "missing".
    const storeSeo0 = (store as any).seo ?? {};
    const categoryIds = [...new Set((products as any[]).map((p) => p.categoryId).filter(Boolean).map(String))];
    const categories: any[] = categoryIds.length
      ? await this.db.repositories.categoryModel.find({ _id: { $in: categoryIds } }).select('seo').lean()
      : [];
    const categorySeo = new Map(categories.map((c) => [String(c._id), c.seo ?? {}]));

    for (const product of products as any[]) {
      const seo = product.seo ?? {};
      const productRef = { entityType: 'product' as const, entityId: product._id.toString() };

      // The text actually served when the seller wrote none: product, then its category, then the store.
      const catSeo = categorySeo.get(String(product.categoryId)) ?? {};
      const customTitle: string | undefined = seo.metaTitle || catSeo.metaTitle || storeSeo0.metaTitle || undefined;
      const customDescription: string | undefined = seo.metaDescription || catSeo.metaDescription || storeSeo0.metaDescription || undefined;

      if (isEnabled('title_length') && customTitle) {
        // Only a title the seller (or the category / store) wrote can be too long; the automatic "Name – Store" title is not reported.
        const max = threshold('title_length', 'max', 60);
        if (customTitle.length > max) {
          issues.push({ severity: severityOf('title_length', 'warning'), code: 'title_length', message: `Product "${product.name}" meta title exceeds ${max} characters.`, ...productRef });
        }
      }

      if (isEnabled('description_length')) {
        const min = threshold('description_length', 'min', 70);
        const max = threshold('description_length', 'max', 160);
        if (customDescription) {
          if (customDescription.length < min || customDescription.length > max) {
            issues.push({ severity: severityOf('description_length', 'info'), code: 'description_length', message: `Product "${product.name}" meta description is outside the ideal ${min}-${max} character range.`, ...productRef });
          }
        } else if (!String(product.description ?? '').trim()) {
          // No meta description AND no product description: the page really has nothing to show in search results.
          issues.push({ severity: severityOf('description_length', 'warning'), code: 'description_length', message: `Product "${product.name}" has no meta description and no product description, so search results have nothing to show.`, ...productRef });
        }
      }

      // No per-image alt-text field exists in this codebase's Product schema
      // (images are plain URL strings) — approximated as "has no images at
      // all", which is the closest real signal this data model can offer.
      if (isEnabled('missing_alt_text') && (!product.images || product.images.length === 0)) {
        issues.push({ severity: severityOf('missing_alt_text', 'warning'), code: 'missing_alt_text', message: `Product "${product.name}" has no images (no alt-text opportunity, weaker image-search visibility).`, ...productRef });
      }

      if (isEnabled('thin_content')) {
        const minWords = threshold('thin_content', 'minChars', 100);
        if ((product.description?.length ?? 0) < minWords) {
          issues.push({ severity: severityOf('thin_content', 'warning'), code: 'thin_content', message: `Product "${product.name}" description is thin (under ${minWords} characters) — may read as low-value content to search engines.`, ...productRef });
        }
      }

      // Product JSON-LD (SeoSchemaGeneratorService) needs a non-empty `image`
      // array to be eligible for Google's rich product results.
      if (isEnabled('missing_schema') && (!product.images || product.images.length === 0)) {
        issues.push({ severity: severityOf('missing_schema', 'info'), code: 'missing_schema', message: `Product "${product.name}" has no images, so its structured data won't qualify for rich results.`, ...productRef });
      }

      // Two products can share a title through the category or store meta, or simply by having the same name.
      const effectiveTitle = (customTitle ?? ((store as any).name ? `${product.name} – ${(store as any).name}` : product.name)).trim().toLowerCase();
      const list = titleCounts.get(effectiveTitle) ?? [];
      list.push(product._id.toString());
      titleCounts.set(effectiveTitle, list);
    }

    if (isEnabled('duplicate_meta')) {
      for (const [title, ids] of titleCounts) {
        if (ids.length > 1) {
          issues.push({ severity: severityOf('duplicate_meta', 'warning'), code: 'duplicate_meta', message: `${ids.length} products share the identical meta title "${title}".`, entityType: 'product', entityId: ids[0] });
        }
      }
    }

    // missing_canonical / broken_internal_link — validate any manually-set
    // canonicalUrlOverride still points at a real product in this store
    // (the only "internal link" surface sellers can currently author here).
    if (isEnabled('missing_canonical') || isEnabled('broken_internal_link')) {
      const slugToProduct = new Map((products as any[]).map((p) => [p.slug, p]));
      for (const product of products as any[]) {
        const override: string | undefined = product.seo?.canonicalUrlOverride;
        if (!override) continue;
        const match = override.match(/\/product\/([^/?#]+)/);
        if (match && !slugToProduct.has(match[1])) {
          issues.push({ severity: severityOf('broken_internal_link', 'error'), code: 'broken_internal_link', message: `Product "${product.name}"'s canonical override points at a slug that no longer exists.`, entityType: 'product', entityId: product._id.toString() });
        }
      }
    }

    const storeSeo = storeSeo0;
    // The store page falls back to the store name as its title, so only a missing NAME is a real problem; a description is
    // served from the store's own description when there is no meta description.
    if (isEnabled('title_length') && !storeSeo.metaTitle && !String((store as any).name ?? '').trim()) {
      issues.push({ severity: 'warning', code: 'title_length', message: 'Store has no name or meta title, so the home page has no title.', entityType: 'store', entityId: storeId });
    }
    if (isEnabled('description_length') && !storeSeo.metaDescription && !String((store as any).description ?? '').trim()) {
      issues.push({ severity: 'warning', code: 'description_length', message: 'Store has no meta description and no store description, so the home page has nothing to show in search results.', entityType: 'store', entityId: storeId });
    }

    const checklistCompletionPercent = checklist.length ? Math.round((checklist.filter((c) => c.done).length / checklist.length) * 100) : 0;
    const score = computeScore(issues, checklistCompletionPercent, (products as any[]).length + 1);

    const result = await this.db.repositories.seoAuditResultModel.create({
      storeId, score, issues, checklistCompletionPercent, runAt: new Date(),
    });

    await this.activityLog.log({
      storeId, category: 'seo', action: 'seo_audit_run',
      description: `SEO audit run — score ${score}, ${issues.length} issue(s)`,
      targetType: 'seo_audit',
    });

    return result;
  }
}

/** The most weight one page (a product, or the store) can lose across all checks; the score is measured against this budget. */
const ISSUE_BUDGET_PER_ENTITY = 15;

/**
 * 0-100. The weight of every issue is compared with what the store could lose in total (pages checked x the budget per page),
 * so a store with 500 products and a few problems is not scored 0 only because it is big, and a store with ten products that all
 * have problems still scores low. A store with no issues scores 100 on content.
 */
export function computeScore(issues: AuditIssue[], checklistCompletionPercent: number, entityCount = 1): number {
  const deduction = issues.reduce((sum, issue) => sum + (SEVERITY_WEIGHT[issue.severity] ?? 1), 0);
  const budget = Math.max(1, entityCount) * ISSUE_BUDGET_PER_ENTITY;
  const contentScore = Math.max(0, 100 - (100 * deduction) / budget);
  // Weighted blend: content issues matter most, checklist completion is a smaller factor.
  return Math.round(contentScore * 0.8 + checklistCompletionPercent * 0.2);
}
