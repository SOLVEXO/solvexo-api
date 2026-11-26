import { BadRequestException } from '@nestjs/common';

/**
 * "Content items" — the free content layer every section may carry.
 *
 * A seller can put any number of headings / sub-headings / paragraphs /
 * buttons / images on ANY section, each one with its own position (one of nine
 * anchors), width, alignment, colour and size. The storefront draws them in a
 * 3×3 grid over the section (`storefront-themes/shared/SectionContentLayer`),
 * so nothing is tied to a single hard-coded heading/subheading/button slot.
 *
 * This file is the runtime contract; `section-settings.types.ts` mirrors it.
 */

export const CONTENT_ITEM_KINDS = ['heading', 'subheading', 'text', 'button', 'image'] as const;
export type ContentItemKind = (typeof CONTENT_ITEM_KINDS)[number];

export const CONTENT_ITEM_ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
] as const;
export type ContentItemAnchor = (typeof CONTENT_ITEM_ANCHORS)[number];

export const CONTENT_ITEM_WIDTHS = ['narrow', 'normal', 'wide', 'full'] as const;
export type ContentItemWidth = (typeof CONTENT_ITEM_WIDTHS)[number];

export const CONTENT_ITEM_ALIGNS = ['left', 'center', 'right'] as const;
export type ContentItemAlign = (typeof CONTENT_ITEM_ALIGNS)[number];

export const CONTENT_ITEM_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export type ContentItemSize = (typeof CONTENT_ITEM_SIZES)[number];

export const MAX_CONTENT_ITEMS = 30;

export interface ContentItem {
  /** Stable id so the editor can key rows (never trusted for rendering). */
  id?: string;
  kind: ContentItemKind;
  /** Heading / sub-heading / paragraph / button label. */
  text?: string;
  /** Image only. */
  imageUrl?: string;
  /** Button + image only. */
  link?: unknown;
  anchor?: ContentItemAnchor;
  width?: ContentItemWidth;
  align?: ContentItemAlign;
  color?: string;
  size?: ContentItemSize;
  /** Free desktop-only nudge (px) on top of `anchor`. */
  offsetX?: number;
  offsetY?: number;
}

/** Max characters per kind — mirrors the editor's `maxLength`. */
const TEXT_LIMIT: Record<ContentItemKind, number> = {
  heading: 150,
  subheading: 200,
  text: 2000,
  button: 40,
  image: 0,
};

export interface ContentItemDeps {
  /** The section validator's own link check (kept out of this file to avoid a cycle). */
  assertLink: (link: unknown, field: string) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates `settings.contentItems`. Missing / empty = nothing to draw (the
 * normal case: the vast majority of sections carry no free content).
 */
export function assertContentItems(value: unknown, deps: ContentItemDeps, field = 'contentItems'): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be a list`);
  if (value.length > MAX_CONTENT_ITEMS) {
    throw new BadRequestException(`${field}: at most ${MAX_CONTENT_ITEMS} items`);
  }
  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`;
    if (!isObject(raw)) throw new BadRequestException(`${at} must be an object`);
    const kind = raw.kind;
    if (typeof kind !== 'string' || !(CONTENT_ITEM_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`${at}.kind must be one of ${CONTENT_ITEM_KINDS.join(', ')}`);
    }
    const limit = TEXT_LIMIT[kind as ContentItemKind];
    if (limit > 0) {
      const text = raw.text;
      if (text !== undefined && text !== null && (typeof text !== 'string' || text.length > limit)) {
        throw new BadRequestException(`${at}.text must be text of at most ${limit} characters`);
      }
    }
    if (kind === 'image' || kind === 'button') {
      const url = raw.imageUrl;
      if (url !== undefined && url !== null && url !== '') {
        if (typeof url !== 'string' || url.length > 2000 || !/^https:\/\//i.test(url)) {
          throw new BadRequestException(`${at}.imageUrl must be an https link`);
        }
      }
    }
    if (kind === 'button' || kind === 'image') {
      if (raw.link !== undefined && raw.link !== null && raw.link !== '') deps.assertLink(raw.link, `${at}.link`);
    }
    if (raw.anchor !== undefined && raw.anchor !== null && !(CONTENT_ITEM_ANCHORS as readonly unknown[]).includes(raw.anchor)) {
      throw new BadRequestException(`${at}.anchor must be one of ${CONTENT_ITEM_ANCHORS.join(', ')}`);
    }
    if (raw.width !== undefined && raw.width !== null && !(CONTENT_ITEM_WIDTHS as readonly unknown[]).includes(raw.width)) {
      throw new BadRequestException(`${at}.width must be one of ${CONTENT_ITEM_WIDTHS.join(', ')}`);
    }
    if (raw.align !== undefined && raw.align !== null && !(CONTENT_ITEM_ALIGNS as readonly unknown[]).includes(raw.align)) {
      throw new BadRequestException(`${at}.align must be one of ${CONTENT_ITEM_ALIGNS.join(', ')}`);
    }
    if (raw.size !== undefined && raw.size !== null && !(CONTENT_ITEM_SIZES as readonly unknown[]).includes(raw.size)) {
      throw new BadRequestException(`${at}.size must be one of ${CONTENT_ITEM_SIZES.join(', ')}`);
    }
    // Free nudge on top of the 9 anchors (desktop only — the storefront
    // drops the offset on phones so a column can never be pushed off screen).
    for (const axis of ['offsetX', 'offsetY'] as const) {
      const value = raw[axis];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2000) {
        throw new BadRequestException(`${at}.${axis} must be a number of pixels between -2000 and 2000`);
      }
    }
    const color = raw.color;
    if (color !== undefined && color !== null && color !== '' && (typeof color !== 'string' || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color))) {
      throw new BadRequestException(`${at}.color must be a colour like #AABBCC`);
    }
  }
}