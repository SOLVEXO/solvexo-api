# AI text generation

One service, `TextGenerationService`, writes text with Claude (or canned text in development). It is used by:

- storefront text / interface / email text **auto-translation** (`store-text-translations`, `ui-locales`, `notifications/store-notification-settings`)
- the admin **sales agent** (`sales-ops/sales-agent.service.ts`)

Other places that call Claude have their own small clients: **AI SEO suggestions** (`seo/providers/anthropic-seo-ai.provider.ts`, charged to the
AI credits wallet in `platform-plans/ai-credits.service.ts`) and the **login / onboarding background photo check** (`common/auth-visual.service.ts`).

(The seller "AI Studio" tools were removed on 2026-11-11 by the owner's decision. The `ai_generations` / `ai_credit_transactions` collections are
no longer used by any code; their old data was left in the database.)

## Environment

```bash
AI_PROVIDER=claude          # default: mock (canned text, no spend). In production the mock is refused: without a real provider the AI features say "not available".
ANTHROPIC_API_KEY=sk-ant-...  # required when AI_PROVIDER=claude (also used directly by AI SEO and the photo check)
AI_MODEL=claude-haiku-4-5   # ONE model for every AI feature (default). Optional per-feature overrides:
AI_TEXT_MODEL_STANDARD=     # translation text
AI_TEXT_MODEL_ADVANCED=     # structured JSON / web-search calls
AI_SEO_MODEL=               # AI SEO suggestions only
AUTH_VISUAL_VETTING_MODEL=  # background photo check only
AI_ALLOW_MOCK=true          # development only: allow the canned text provider
```

Do not send sampling parameters (temperature, top_p, top_k), thinking budgets or prefills: newer Claude models reject them.
The web search tool type follows the model (`common/ai-model.util.ts`).
