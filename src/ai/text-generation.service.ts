/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { aiModel } from '@/common/ai-model.util';
import { ConfigService } from '@nestjs/config';
import {
  AiProviderError, TextGenerationAdapter, TextGenerationRequest, TextGenerationResult,
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
  private readonly keyMissing: boolean;
  private readonly mockAllowed: boolean;

  constructor(config: ConfigService) {
    this.providerName = (config.get<string>('AI_PROVIDER') as 'mock' | 'claude') ?? 'mock';
    // Canned (mock) text is fine for development and tests, never for real sellers who are charged credits for it.
    this.mockAllowed = config.get<string>('AI_ALLOW_MOCK') === 'true'
      || ['development', 'test'].includes(String(config.get<string>('NODE_ENV') ?? process.env.NODE_ENV))
      || !!process.env.JEST_WORKER_ID;

    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.keyMissing = this.providerName === 'claude' && !apiKey;
    if (this.providerName === 'claude' && apiKey) {
      this.provider = new ClaudeTextGenerationProvider(apiKey, {
        standardModel: aiModel(config.get<string>('AI_TEXT_MODEL_STANDARD')),
        advancedModel: aiModel(config.get<string>('AI_TEXT_MODEL_ADVANCED')),
      });
    } else if (this.keyMissing) {
      // A missing key must not take the whole API down, and must never fall back to canned text: every call fails clearly instead.
      this.provider = { name: 'claude', generate: async () => { throw new AiProviderError('AI is not switched on yet.', { retryable: true, provider: 'claude' }); } };
    } else {
      this.provider = new MockTextGenerationProvider();
    }
  }

  get name(): string {
    return this.provider.name;
  }

  /** True when real generations can run (or mock text is allowed because this is development/test). */
  get isAvailable(): boolean {
    if (this.providerName === 'claude') return !this.keyMissing;
    return this.mockAllowed;
  }

  /** Called before anything is held or charged: the AI features refuse instead of passing canned text off as real. */
  assertAvailable(): void {
    if (!this.isAvailable) {
      throw new ServiceUnavailableException('AI is being set up and is not available yet. No credits were used.');
    }
  }

  onModuleInit() {
    this.logger.log(`AI text generation running on provider: "${this.providerName}"`);
    if (this.keyMissing) {
      this.logger.error('AI_PROVIDER=claude but ANTHROPIC_API_KEY is not set: AI text features are OFF until the key is set.');
    } else if (this.providerName === 'mock') {
      this.logger.warn(this.mockAllowed
        ? 'AI_PROVIDER=mock — canned responses only (development/test). Set AI_PROVIDER=claude with ANTHROPIC_API_KEY for real generations.'
        : 'AI_PROVIDER is not claude: AI text features are OFF in production (canned text is never passed off as real). Set AI_PROVIDER=claude with ANTHROPIC_API_KEY, or AI_ALLOW_MOCK=true for a demo.');
    }
  }

  generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    return this.provider.generate(request);
  }
}
