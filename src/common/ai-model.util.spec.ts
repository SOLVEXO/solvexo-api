import { aiModel, webSearchToolType, DEFAULT_AI_MODEL } from './ai-model.util';

/** Runs a check with AI_MODEL set (or unset) and always puts the old value back. */
function withModel(value: string | undefined, fn: () => void) {
  const saved = process.env.AI_MODEL;
  if (value === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = value;
  try { fn(); } finally { if (saved === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = saved; }
}

describe('one AI model for every feature', () => {
  it('uses one cheap default when nothing is set', () => {
    withModel(undefined, () => {
      expect(aiModel()).toBe(DEFAULT_AI_MODEL);
      expect(aiModel(undefined)).toBe(DEFAULT_AI_MODEL);
      expect(aiModel('  ')).toBe(DEFAULT_AI_MODEL);
    });
  });
  it('AI_MODEL changes every feature at once', () => {
    withModel('claude-sonnet-5', () => {
      expect(aiModel()).toBe('claude-sonnet-5');
      expect(aiModel(undefined)).toBe('claude-sonnet-5');
    });
  });
  it('a feature-specific variable still wins when someone has set it', () => {
    withModel('claude-sonnet-5', () => {
      expect(aiModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    });
  });
  it('web search uses the basic tool on Haiku and the newer one elsewhere', () => {
    expect(webSearchToolType('claude-haiku-4-5')).toBe('web_search_20250305');
    expect(webSearchToolType('claude-haiku-5-5')).toBe('web_search_20250305');
    expect(webSearchToolType('claude-sonnet-5')).toBe('web_search_20260209');
  });
});
