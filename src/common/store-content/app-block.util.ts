/* eslint-disable prettier/prettier */
import type { SectionType } from '../schemas/section.schema';

/**
 * Phase 8 — App Blocks. Pure, dependency-free helpers (no DB access, matches
 * this file's neighbor `section-settings.validator.ts`'s own convention) for
 * recognizing an app-provided block's `Block.type` string. `Block.type` stays
 * a plain, non-enum-locked string at the schema level (see `block.schema.ts`)
 * — an app block is just a block whose `type` is namespaced
 * `app:<appId>:<blockKey>` instead of one of the fixed first-party names
 * (`heading`, `paragraph`, ...). Nothing about the schema/storage layer
 * changes; only which types are ALLOWED inside which section (see
 * `APP_BLOCK_CAPABLE_SECTION_TYPES` below) and how they're validated
 * (`apps/app-catalog.ts`, which DOES need DB access to check store
 * installation — kept out of this pure file on purpose).
 */

export const APP_BLOCK_TYPE_PREFIX = 'app:';

export function isAppBlockType(type: string): boolean {
  return typeof type === 'string' && type.startsWith(APP_BLOCK_TYPE_PREFIX);
}

export function buildAppBlockType(appId: string, blockKey: string): string {
  return `${APP_BLOCK_TYPE_PREFIX}${appId}:${blockKey}`;
}

/** `null` for a malformed type (e.g. missing the block-key half) — callers
 *  treat that as "not a valid app block", never as "not an app block at all"
 *  (use `isAppBlockType` first to tell those apart). */
export function parseAppBlockType(type: string): { appId: string; blockKey: string } | null {
  if (!isAppBlockType(type)) return null;
  const rest = type.slice(APP_BLOCK_TYPE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return null;
  const appId = rest.slice(0, sep);
  const blockKey = rest.slice(sep + 1);
  if (!appId || !blockKey) return null;
  return { appId, blockKey };
}

/**
 * Which real, first-party section types may ALSO host an app-provided block
 * alongside their own fixed block types — an explicit allow-list (Shopify's
 * own model: a theme section opts into `"blocks": [{"type": "@app"}]`, it
 * isn't automatic for every section). `rich_text` is the one section type
 * this MVP actually wires end-to-end (both themes already register it — see
 * `RichTextSection.tsx` in each theme). Extending this to another section
 * type later means: (1) add it here, (2) add the matching render dispatch
 * in that section's own render function in each theme, (3) have at least
 * one real `AppDefinition.blocks[].supportedSectionTypes` include it —
 * never just adding the type here alone, which would silently allow a
 * merchant to add an app block that renders as nothing.
 */
export const APP_BLOCK_CAPABLE_SECTION_TYPES: readonly SectionType[] = ['rich_text'];

export function sectionAcceptsAppBlocks(sectionType: SectionType): boolean {
  return APP_BLOCK_CAPABLE_SECTION_TYPES.includes(sectionType);
}
