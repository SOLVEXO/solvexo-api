/* eslint-disable prettier/prettier */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { aiModel } from '@/common/ai-model.util';
import Anthropic from '@anthropic-ai/sdk';
import { ISeoAiProvider, SeoAiSuggestion, SeoAiSuggestionInput } from './seo-ai-provider.interface';

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    metaTitle: { type: 'string' },
    metaDescription: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
  },
  required: ['metaTitle', 'metaDescription', 'keywords'],
  additionalProperties: false,
};

/**
 * Claude-backed AI SEO suggestion generator — the first implementation of
 * `ISeoAiProvider`. Uses structured outputs (`output_config.format`) rather
 * than free-text parsing, so a malformed response is a hard API error
 * (caught below) instead of a silent bad-JSON parse downstream.
 *
 * The model is the ONE shared AI model (`AI_MODEL`, see common/ai-model.util.ts); `AI_SEO_MODEL` still overrides it for this
 * feature only. Thinking is not requested, and `max_tokens` leaves room in case a model with always-on thinking is configured.
 */
/** Kept for older imports; the model actually used comes from `aiModel()`. */
export const DEFAULT_SEO_AI_MODEL = 'claude-opus-4-8';

@Injectable()
export class AnthropicSeoAiProvider implements ISeoAiProvider {
  private readonly logger = new Logger(AnthropicSeoAiProvider.name);
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  /** False until an API key is configured: the caller refuses BEFORE charging any credits. */
  get isConfigured(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  async generateSuggestion(input: SeoAiSuggestionInput): Promise<SeoAiSuggestion> {
    const prompt = buildPrompt(input);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: aiModel(process.env.AI_SEO_MODEL),
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: SUGGESTION_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      });
    } catch (err: any) {
      // Any API / network / credential failure: log the real reason, show the seller a short message (the credits are refunded by the caller).
      this.logger.error(`AI SEO call failed${err?.status ? ` (${err.status})` : ''}: ${err?.message ?? err}`);
      throw new ServiceUnavailableException('AI SEO is not available right now. No credits were used - please try again in a moment.');
    }

    if (response.stop_reason === 'refusal') {
      throw new ServiceUnavailableException('AI SEO suggestion request was declined by the safety classifier.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ServiceUnavailableException('AI SEO suggestion was cut off before it finished. No credits were used - please try again.');
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) {
      this.logger.error(`No text block in AI SEO suggestion response for entity "${input.name}"`);
      throw new ServiceUnavailableException('AI SEO suggestion generation returned no usable output.');
    }

    try {
      const parsed = JSON.parse(textBlock.text);
      return {
        metaTitle: String(parsed.metaTitle).slice(0, 70),
        metaDescription: String(parsed.metaDescription).slice(0, 320),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 15).map(String) : [],
      };
    } catch (err: any) {
      this.logger.error(`Failed to parse AI SEO suggestion JSON: ${err?.message}`);
      throw new ServiceUnavailableException('AI SEO suggestion generation returned malformed output.');
    }
  }
}

function buildPrompt(input: SeoAiSuggestionInput): string {
  const context = [
    `Entity type: ${input.entityType}`,
    `Name: ${input.name}`,
    input.description ? `Description: ${input.description}` : null,
    input.categoryName ? `Category: ${input.categoryName}` : null,
    input.storeName ? `Store: ${input.storeName}` : null,
  ].filter(Boolean).join('\n');

  return `You are an SEO copywriter for an e-commerce marketplace. Given the following ${input.entityType} details, write:
- metaTitle: a compelling, keyword-rich page title, 50-60 characters
- metaDescription: an enticing meta description, 140-160 characters, that encourages clicks
- keywords: 5-10 relevant search keywords/phrases

${context}

Respond with only the requested fields — no extra commentary.`;
}
