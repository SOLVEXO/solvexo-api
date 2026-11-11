/**
 * ONE Claude model for every AI feature (AI SEO suggestions, auto-translation, the admin sales agent, auth-photo vetting),
 * so there is a single price to watch. Set `AI_MODEL` to change it for all of them at once. The old per-feature variables
 * (AI_TEXT_MODEL_STANDARD, AI_TEXT_MODEL_ADVANCED, AI_SEO_MODEL, AUTH_VISUAL_VETTING_MODEL) still win when someone sets
 * them, so nothing that is already configured changes behaviour.
 */
export const DEFAULT_AI_MODEL = 'claude-haiku-4-5';

export function aiModel(specific?: string | null): string {
  return (specific && specific.trim()) || (process.env.AI_MODEL && process.env.AI_MODEL.trim()) || DEFAULT_AI_MODEL;
}

/**
 * The web search server tool comes in two versions. The newer one (dynamic filtering) is only offered on the bigger models;
 * Haiku models use the basic one. Picking by model name means switching `AI_MODEL` never breaks the tools that search the web.
 */
export function webSearchToolType(model: string): 'web_search_20250305' | 'web_search_20260209' {
  return /haiku/i.test(model) ? 'web_search_20250305' : 'web_search_20260209';
}
