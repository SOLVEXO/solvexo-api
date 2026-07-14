/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import {
  KeywordDataAdapter, KeywordLookupResult, KeywordSignal,
} from './ai-provider.interfaces';
import { TextGenerationService } from './text-generation.service';

const KEYWORD_LOOKUP_SCHEMA = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          searchIntent: { type: 'string' },
          competition: { type: 'string', enum: ['low', 'medium', 'high'] },
          rationale: { type: 'string' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
  },
  required: ['keywords'],
  additionalProperties: false,
};

/**
 * KeywordDataAdapter implemented with Claude + the built-in web search tool
 * (via TextGenerationService, so mock mode works transparently).
 *
 * Every returned signal carries `isVerifiedData: false`: web-search-grounded
 * LLM output beats pure generation, but it is NOT the same reliability tier
 * as a dedicated keyword-metrics API (Ahrefs/Semrush/Google Keyword Planner).
 * Swapping one of those in later is a drop-in: implement KeywordDataAdapter,
 * set the flag true, and no caller changes.
 *
 * Failures degrade to `{ keywords: [], lowConfidence: true }` rather than
 * throwing — the SEO Booster can still do its LLM-only writing step.
 */
@Injectable()
export class KeywordDataService implements KeywordDataAdapter {
  private readonly logger = new Logger(KeywordDataService.name);

  constructor(private readonly textGeneration: TextGenerationService) {}

  async lookupKeywords(params: {
    topic: string;
    categoryName?: string;
    currentTags?: string[];
    maxKeywords?: number;
  }): Promise<KeywordLookupResult> {
    const max = params.maxKeywords ?? 12;
    try {
      const result = await this.textGeneration.generate({
        tier: 'advanced',
        webSearch: { maxUses: 3 },
        schema: KEYWORD_LOOKUP_SCHEMA,
        maxTokens: 2048,
        system: 'You are an e-commerce SEO researcher. Use web search to ground your answer in what buyers actually search for right now — current trends, competitor listings, and marketplace search suggestions. Never invent search-volume numbers.',
        prompt: [
          `Research up to ${max} search keywords/tags that would help a marketplace product rank for this topic: "${params.topic}".`,
          params.categoryName ? `Product category: ${params.categoryName}.` : '',
          params.currentTags?.length ? `The seller currently uses these tags: ${params.currentTags.join(', ')}. Prefer better or complementary ones.` : '',
          'For each keyword include the likely search intent, a rough competition level (low/medium/high) based on what you found, and a one-line rationale.',
        ].filter(Boolean).join('\n'),
      });

      const raw = Array.isArray(result.json?.keywords) ? result.json!.keywords : [];
      const keywords: KeywordSignal[] = raw
        .filter((k: any) => typeof k?.keyword === 'string' && k.keyword.trim())
        .slice(0, max)
        .map((k: any) => ({
          keyword: k.keyword.trim(),
          searchIntent: k.searchIntent,
          competition: ['low', 'medium', 'high'].includes(k.competition) ? k.competition : undefined,
          rationale: k.rationale,
          isVerifiedData: false, // web-grounded LLM estimate — not a metrics-API measurement
        }));

      return { keywords, provider: result.provider, lowConfidence: keywords.length === 0 };
    } catch (error) {
      this.logger.warn(`Keyword lookup failed (provider: ${this.textGeneration.providerName}): ${(error as Error).message}`);
      return { keywords: [], provider: this.textGeneration.providerName, lowConfidence: true };
    }
  }
}
