/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TextGenerationAdapter, TextGenerationRequest, TextGenerationResult,
} from './ai-provider.interfaces';
import { ClaudeTextGenerationProvider } from './claude-text.provider';
import { MockTextGenerationProvider } from './mock-text.provider';

/**
 * TextGenerationService — delegates to the active provider selected via env,
 * mirroring PaymentGatewayService's provider-selection pattern.
 *
 * AI_PROVIDER=mock    → MockTextGenerationProvider (default — no API key, no spend)
 * AI_PROVIDER=claude  → ClaudeTextGenerationProvider (requires ANTHROPIC_API_KEY)
 *
 * Model IDs come from env so upgrades never require a code change:
 *   AI_TEXT_MODEL_STANDARD  (default: claude-haiku-4-5)   — Listing Writer, Email
 *                            Campaigns, SEO Booster writing step
 *   AI_TEXT_MODEL_ADVANCED  (default: claude-sonnet-5)    — Worksheet Builder
 *                            structured JSON + all web-search-grounded calls
 */
@Injectable()
export class TextGenerationService implements TextGenerationAdapter, OnModuleInit {
  private readonly logger = new Logger(TextGenerationService.name);
  private readonly provider: TextGenerationAdapter;
  readonly providerName: 'mock' | 'claude';

  constructor(config: ConfigService) {
    this.providerName = (config.get<string>('AI_PROVIDER') as 'mock' | 'claude') ?? 'mock';

    if (this.providerName === 'claude') {
      const apiKey = config.get<string>('ANTHROPIC_API_KEY');
      if (!apiKey) {
        throw new Error('AI_PROVIDER=claude requires ANTHROPIC_API_KEY to be set in the environment');
      }
      this.provider = new ClaudeTextGenerationProvider(apiKey, {
        standardModel: config.get<string>('AI_TEXT_MODEL_STANDARD') ?? 'claude-haiku-4-5',
        advancedModel: config.get<string>('AI_TEXT_MODEL_ADVANCED') ?? 'claude-sonnet-5',
      });
    } else {
      this.provider = new MockTextGenerationProvider();
    }
  }

  get name(): string {
    return this.provider.name;
  }

  onModuleInit() {
    this.logger.log(`AI Studio text generation running on provider: "${this.providerName}"`);
    if (this.providerName === 'mock') {
      this.logger.warn('AI_PROVIDER=mock — canned responses only. Set AI_PROVIDER=claude with ANTHROPIC_API_KEY for real generations.');
    }
  }

  generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    return this.provider.generate(request);
  }
}
