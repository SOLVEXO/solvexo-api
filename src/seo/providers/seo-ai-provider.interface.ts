/* eslint-disable prettier/prettier */
export interface SeoAiSuggestionInput {
  entityType: 'product' | 'category' | 'store';
  name: string;
  description?: string | null;
  categoryName?: string | null;
  storeName?: string | null;
}

export interface SeoAiSuggestion {
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
}

/**
 * Strategy interface for AI-generated SEO suggestions — same
 * one-adapter-per-provider shape as `ISeoSearchProvider` (architecture plan
 * Refinement #2). First implementation is `AnthropicSeoAiProvider`; a second
 * provider drops in later without touching `SeoAiService`.
 */
export interface ISeoAiProvider {
  generateSuggestion(input: SeoAiSuggestionInput): Promise<SeoAiSuggestion>;
}
