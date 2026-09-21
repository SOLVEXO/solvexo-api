/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import type { SectionType } from '../common/schemas/section.schema';
import { buildAppBlockType } from '../common/store-content/app-block.util';

/**
 * Phase 8 — App Blocks: the app catalog itself.
 *
 * This MVP's "apps" are a fixed, code-defined catalog — analogous to
 * Shopify's own first-party apps, NOT a third-party developer marketplace.
 * A real open marketplace (developers submitting/uploading their own app
 * code, an app review pipeline, OAuth scoped access, revenue share) was
 * already evaluated and explicitly ruled out for this codebase in an
 * earlier pass (see the "Apps & Sales Channels" conclusion elsewhere in
 * this project's history) — running arbitrary third-party code inside this
 * process, or even in a sandboxed worker, is a multi-month security/infra
 * project on its own, well beyond "add App Blocks." This catalog is the
 * safe, honest middle ground Shopify's OWN app-block security model
 * actually relies on too: an app's block is DATA (a settings schema) plus
 * a fixed, already-reviewed RENDER IMPLEMENTATION — never code the app
 * itself supplies at runtime. Installing/uninstalling an app is real,
 * per-store, tenant-isolated state (`AppInstallation`); the catalog
 * entries themselves are not something a merchant or a third party can
 * add without a real code change and redeploy — exactly like adding a new
 * section type already works in this codebase.
 *
 * `renderKind` keys the FRONTEND's own fixed component registry
 * (`features/storefront/AppBlockRenderer.tsx`) — never a URL, a script,
 * or anything dynamically loaded/executed. The frontend catalog
 * (`solvexo/.../builder/appBlockCatalog.ts`) mirrors this file's shape by
 * hand, same "kept in sync by hand" convention this codebase already uses
 * for `sectionSettingsTypes.ts`.
 */

export type AppBlockFieldKind = 'text' | 'textarea' | 'number' | 'boolean' | 'select';

export interface AppBlockFieldOption {
  value: string;
  label: string;
}

export interface AppBlockField {
  key: string;
  label: string;
  kind: AppBlockFieldKind;
  required?: boolean;
  maxLength?: number;
  options?: AppBlockFieldOption[];
}

export interface AppBlockDefinition {
  /** The stable key used inside `Block.type` (`app:<appId>:<key>`). */
  key: string;
  label: string;
  description: string;
  /** Which first-party section types this block may be added into — must
   *  be a subset of `APP_BLOCK_CAPABLE_SECTION_TYPES` (see
   *  `app-block.util.ts`); a section type not in THAT list can never host
   *  any app block at all, regardless of what an app declares here. */
  supportedSectionTypes: SectionType[];
  settingsSchema: AppBlockField[];
  /** Keys the frontend's fixed render-component registry — see this
   *  file's own doc comment. */
  renderKind: string;
}

export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  blocks: AppBlockDefinition[];
}

/**
 * The one real demo app this MVP ships, deliberately labeled as a sample —
 * proves the whole pipeline (install → add block → configure → reorder →
 * hide/show → remove → publish → real storefront) end to end without
 * pretending to be a real third-party integration. A future real app is
 * added the same way: a new `AppDefinition` entry here, its own
 * `renderKind` implementation registered in the frontend renderer registry
 * — no other part of this system needs to change.
 */
export const APP_CATALOG: AppDefinition[] = [
  {
    id: 'trust-signals',
    name: 'Trust Signals (Sample App)',
    description: 'A sample App Blocks provider — adds a configurable trust/rating badge merchants can drop into a Rich Text section. Ships with this platform to demonstrate the App Blocks extension system; not a real third-party integration.',
    blocks: [
      {
        key: 'rating_badge',
        label: 'Rating Badge',
        description: 'A small badge with custom text and an optional 5-star row.',
        supportedSectionTypes: ['rich_text'],
        settingsSchema: [
          { key: 'text', label: 'Badge text', kind: 'text', required: true, maxLength: 60 },
          { key: 'showStars', label: 'Show 5-star row', kind: 'boolean' },
        ],
        renderKind: 'rating_badge',
      },
    ],
  },
];

export function findApp(appId: string): AppDefinition | undefined {
  return APP_CATALOG.find(a => a.id === appId);
}

export function findAppBlockDefinition(blockType: string): { app: AppDefinition; block: AppBlockDefinition } | null {
  for (const app of APP_CATALOG) {
    const block = app.blocks.find(b => buildAppBlockType(app.id, b.key) === blockType);
    if (block) return { app, block };
  }
  return null;
}

/** Generic, data-driven settings validation — no per-app hardcoded switch.
 *  Every app block's settings are validated against its OWN declared
 *  schema, the same way every other install of this feature (a new app
 *  added to `APP_CATALOG` above) gets real validation for free. */
export function validateAppBlockSettings(def: AppBlockDefinition, settings: Record<string, any> | undefined): void {
  const s = settings ?? {};
  for (const field of def.settingsSchema) {
    const value = s[field.key];
    const missing = value === undefined || value === null || value === '';
    if (field.required && missing) {
      throw new BadRequestException(`"${field.label}" is required for the "${def.label}" app block`);
    }
    if (missing) continue;
    if ((field.kind === 'text' || field.kind === 'textarea') && typeof value !== 'string') {
      throw new BadRequestException(`"${field.label}" must be text`);
    }
    if (field.kind === 'text' || field.kind === 'textarea') {
      if (field.maxLength && typeof value === 'string' && value.length > field.maxLength) {
        throw new BadRequestException(`"${field.label}" must be ${field.maxLength} characters or fewer`);
      }
    }
    if (field.kind === 'number' && typeof value !== 'number') {
      throw new BadRequestException(`"${field.label}" must be a number`);
    }
    if (field.kind === 'boolean' && typeof value !== 'boolean') {
      throw new BadRequestException(`"${field.label}" must be true or false`);
    }
    if (field.kind === 'select' && field.options && !field.options.some(o => o.value === value)) {
      throw new BadRequestException(`"${field.label}" must be one of: ${field.options.map(o => o.value).join(', ')}`);
    }
  }
}
