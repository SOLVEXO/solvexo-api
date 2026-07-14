/* eslint-disable prettier/prettier */
import {
  TextGenerationAdapter, TextGenerationRequest, TextGenerationResult,
} from './ai-provider.interfaces';

/**
 * Canned-response TextGenerationAdapter for local dev/testing — runs the whole
 * AI Studio flow (credits hold/capture, history, apply-to-product) end-to-end
 * without an API key or token spend. Same mock/live pattern as
 * ManualPaymentProvider vs StripePaymentProvider in the Subscriptions module.
 *
 * When a schema is requested, a conforming object is synthesized by walking
 * the schema, so every tool's response shape is exercised realistically.
 */
export class MockTextGenerationProvider implements TextGenerationAdapter {
  readonly name = 'mock';

  async generate(request: TextGenerationRequest): Promise<TextGenerationResult> {
    // Small artificial latency so loading states are visible during dev.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const json = request.schema ? this.synthesize(request.schema, 'root') : null;
    const text = json
      ? JSON.stringify(json)
      : `[mock ${request.tier ?? 'standard'} generation${request.webSearch ? ' + web search' : ''}] ${request.prompt.slice(0, 120)}...`;

    return {
      json,
      text,
      provider: this.name,
      model: `mock-${request.tier ?? 'standard'}`,
      usedWebSearch: !!request.webSearch,
    };
  }

  private synthesize(schema: Record<string, any>, key: string): any {
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    if (schema.const !== undefined) return schema.const;

    switch (schema.type) {
      case 'object': {
        const out: Record<string, any> = {};
        for (const [prop, sub] of Object.entries<Record<string, any>>(schema.properties ?? {})) {
          out[prop] = this.synthesize(sub, prop);
        }
        return out;
      }
      case 'array': {
        const items = schema.items ?? { type: 'string' };
        return [this.synthesize(items, key), this.synthesize(items, key)];
      }
      case 'integer':
      case 'number':
        return 42;
      case 'boolean':
        return false;
      case 'string':
      default:
        return `Mock ${key.replace(/([A-Z])/g, ' $1').toLowerCase()} — placeholder generated locally without an AI provider.`;
    }
  }
}
