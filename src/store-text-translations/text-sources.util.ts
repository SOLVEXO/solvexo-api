/* eslint-disable prettier/prettier */

/** Setting names whose value is text a visitor reads (never links, ids, colours or layout choices). */
export const TRANSLATABLE_KEYS = new Set([
  'heading', 'subheading', 'title', 'subtitle', 'text', 'content', 'body', 'description', 'caption', 'label', 'eyebrow', 'quote',
  'author', 'role', 'question', 'answer', 'placeholder', 'successMessage', 'viewAllLabel', 'buttonLabel', 'buttonText', 'ctaText',
  'ctaLabel', 'message', 'name', 'alt', 'tagline', 'hours', 'address', 'endedText', 'nameLabel', 'emailLabel', 'phoneLabel',
  'messageLabel', 'directionsLabel', 'newsletterHeading', 'newsletterText',
]);

export const MAX_TEXT_LENGTH = 5000;
const MAX_DEPTH = 5;
const MAX_ITEMS_PER_CONTAINER = 120;

export interface TextSourceItem {
  /** `<container>#<path>`; the storefront applies the translation to exactly this spot. */
  key: string;
  /** Short seller-facing name of the field ("Heading", "Links 2 · Label"). */
  label: string;
  source: string;
  multiline: boolean;
}

export interface TextSourceGroup {
  id: string;
  title: string;
  /** store | announcement | header | footer | page | template | faq | category | checkout | blog_post */
  kind: string;
  items: TextSourceItem[];
}

const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** A readable value: not a bare URL, number, colour or empty string. */
export function isTranslatableText(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t || t.length > MAX_TEXT_LENGTH) return false;
  if (/^(https?:\/\/|\/|mailto:|tel:|#)\S*$/i.test(t)) return false;
  if (/^[\d\s.,:+\-/%$€£]+$/.test(t)) return false;
  return true;
}

/** Walks an object/array and lists every translatable string with its dotted path (arrays use the index). */
export function collectTextPaths(value: unknown, prefix = '', depth = 0, out: { path: string; text: string }[] = []): { path: string; text: string }[] {
  if (depth > MAX_DEPTH || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectTextPaths(item, prefix ? `${prefix}.${i}` : String(i), depth + 1, out));
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'labelTranslations' || k === 'translations') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      if (TRANSLATABLE_KEYS.has(k) && isTranslatableText(v)) out.push({ path, text: v });
    } else if (v && typeof v === 'object') {
      collectTextPaths(v, path, depth + 1, out);
    }
  }
  return out;
}

function item(key: string, label: string, source: string): TextSourceItem {
  return { key, label, source, multiline: source.length > 90 || source.includes('\n') || /<\w+/.test(source) };
}

const SECTION_NAME: Record<string, string> = { hero: 'Hero', rich_text: 'Rich text', image_with_text: 'Image with text', faq: 'FAQ', testimonials: 'Testimonials' };

/** Text items of a list of sections (and their blocks), in page order. */
export function collectSectionItems(sections: any[] | null | undefined): TextSourceItem[] {
  const out: TextSourceItem[] = [];
  for (const section of sections ?? []) {
    if (!section || section.enabled === false) continue;
    const sid = String(section._id ?? '');
    if (!sid) continue;
    const name = SECTION_NAME[section.type] ?? humanize(String(section.type ?? 'Section'));
    for (const { path, text } of collectTextPaths(section.settings ?? {}).slice(0, MAX_ITEMS_PER_CONTAINER)) {
      out.push(item(`s:${sid}#${path}`, `${name} · ${humanize(path.split('.').pop() ?? path)}`, text));
    }
    (section.blocks ?? []).forEach((block: any, i: number) => {
      if (!block || block.enabled === false) return;
      const bid = String(block._id ?? i);
      for (const { path, text } of collectTextPaths(block.settings ?? {}).slice(0, MAX_ITEMS_PER_CONTAINER)) {
        out.push(item(`b:${sid}:${bid}#${path}`, `${name} · ${humanize(String(block.type ?? 'Block'))} ${i + 1} · ${humanize(path.split('.').pop() ?? path)}`, text));
      }
    });
  }
  return out;
}

/** Header / footer blocks (nav links, footer columns, contact...). */
export function collectChromeBlockItems(prefix: 'hb' | 'fb', blocks: any[] | null | undefined): TextSourceItem[] {
  const out: TextSourceItem[] = [];
  (blocks ?? []).forEach((block: any, i: number) => {
    if (!block || block.enabled === false) return;
    const id = String(block._id ?? i);
    const kind = humanize(String(block.type ?? 'Block'));
    for (const { path, text } of collectTextPaths(block.settings ?? {}).slice(0, MAX_ITEMS_PER_CONTAINER)) {
      out.push(item(`${prefix}:${id}#${path}`, `${kind} ${i + 1} · ${humanize(path.replace(/\.(\d+)/g, ' $1').split(' ').slice(-2).join(' '))}`, text));
    }
  });
  return out;
}

/** Plain fields of a document (store name, header CTA, footer newsletter heading...). */
export function collectFieldItems(container: string, doc: Record<string, any> | null | undefined, fields: [field: string, label: string][]): TextSourceItem[] {
  const out: TextSourceItem[] = [];
  for (const [field, label] of fields) {
    const v = doc?.[field];
    if (isTranslatableText(v)) out.push(item(`${container}#${field}`, label, v));
  }
  return out;
}

/** What a key may look like on save: a known container prefix, then `#`, then a dotted path. */
export const TEXT_KEY_PATTERN = /^(store|announcement|header|footer|s:[A-Za-z0-9_-]{1,40}|b:[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_-]{1,40}|hb:[A-Za-z0-9_-]{1,40}|fb:[A-Za-z0-9_-]{1,40}|faq:[A-Za-z0-9_-]{1,40}|cat:[A-Za-z0-9_-]{1,40}|ship:[A-Za-z0-9_-]{1,40}|pay:[A-Za-z0-9_-]{1,40}|bp:[A-Za-z0-9_-]{1,40})#[A-Za-z0-9_.]{1,120}$/;

/** A blog post's body: every paragraph / heading / quote / caption / list entry, addressed by its position in `content`. */
export function collectBlogBodyItems(postId: string, content: any[] | null | undefined): TextSourceItem[] {
  const out: TextSourceItem[] = [];
  (content ?? []).forEach((block: any, i: number) => {
    if (!block || block.enabled === false) return;
    const kind = humanize(String(block.type ?? 'Block'));
    const s = block.settings ?? {};
    for (const { path, text } of collectTextPaths(s).slice(0, MAX_ITEMS_PER_CONTAINER)) {
      out.push(item(`bp:${postId}#content.${i}.settings.${path}`, `${kind} ${i + 1} · ${humanize(path.split('.').pop() ?? path)}`, text));
    }
    if (Array.isArray(s.items)) {
      s.items.forEach((entry: unknown, j: number) => {
        if (isTranslatableText(entry)) out.push(item(`bp:${postId}#content.${i}.settings.items.${j}`, `${kind} ${i + 1} · Item ${j + 1}`, entry));
      });
    }
  });
  return out;
}

/**
 * `ui#<key>` = the seller's own wording for one of the storefront's built-in buttons / labels ("Add to cart"), in
 * one language. The key is the i18n key of the storefront bundle (it can contain spaces and punctuation).
 */
export const UI_TEXT_KEY_PATTERN = /^ui#[^\u0000-\u001f#]{1,160}$/;

export function isValidTextKey(key: string): boolean {
  return TEXT_KEY_PATTERN.test(key) || UI_TEXT_KEY_PATTERN.test(key);
}

export const isUiTextKey = (key: string): boolean => key.startsWith('ui#');
