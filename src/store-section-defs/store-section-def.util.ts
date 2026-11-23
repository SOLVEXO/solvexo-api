import { BadRequestException } from '@nestjs/common';

/**
 * A seller-built section ("Section builder"): the seller composes a LAYOUT out of fixed building blocks (stacks, columns, one
 * repeating group, headings, text, images, buttons ...). Every content element owns one field, so the form the seller later
 * fills in is DERIVED from the layout; there is no code anywhere. The tree is plain data with allow-listed properties only.
 *
 * Instances live on pages as `theme_section` with `settings.sectionKey = def.key` ("my.<slug>") and the repeating group's items
 * as `theme_block`, so the existing editor, validators and renderers carry them.
 */

export const CONTAINER_TYPES = ['stack', 'columns', 'repeat'] as const;
export const LEAF_TYPES = ['heading', 'text', 'richtext', 'image', 'button', 'video', 'divider', 'spacer'] as const;

export const MAX_NODES = 60;
export const MAX_DEPTH = 5;
export const MAX_SECTION_FIELDS = 40;
export const MAX_BLOCK_FIELDS = 20;

/** Setting names the platform already uses on every section (design, visibility, copy overrides ...): a field can not take them. */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'sectionKey', 'blockKey', 'heading', 'subheading', 'enabled',
  'spacingTop', 'spacingBottom', 'paddingTop', 'paddingBottom', 'spacingTopMobile', 'spacingBottomMobile', 'paddingTopMobile', 'paddingBottomMobile',
  'visibility', 'fullWidth', 'backgroundImageUrl', 'backgroundOverlay', 'backgroundVideoUrl', 'sectionBgColor', 'gradientFrom', 'gradientTo', 'gradientAngle',
  'borderWidth', 'borderColor', 'borderRadius', 'shadow', 'anchorId', 'customCss',
  'textAlign', 'textAlignMobile', 'textColor', 'headingColor', 'headingWeight', 'headingCase',
  'animation', 'animationSpeed', 'animationDelay', 'sticky', 'stickyOffset',
  'showTo', 'showFrom', 'showUntil', 'showCountries', 'hideCountries', 'showLanguages',
  'showEyebrow', 'eyebrow', 'viewAllLabel', 'placeholder', 'buttonLabel', 'successMessage', 'endedText', 'nameLabel', 'emailLabel', 'phoneLabel', 'messageLabel', 'directionsLabel',
]);

const KEY_RE = /^[a-z][a-zA-Z0-9]{0,29}$/;

export type FieldKind = 'text' | 'textarea' | 'richtext' | 'image' | 'video' | 'link';
export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  maxLength?: number;
  rows?: number;
}

export interface LayoutNode {
  t: (typeof CONTAINER_TYPES)[number] | (typeof LEAF_TYPES)[number];
  [prop: string]: unknown;
  children?: LayoutNode[];
}

export interface DerivedDef {
  layout: LayoutNode;
  fields: FieldDef[];
  block: { key: 'item'; label: string; fields: FieldDef[]; defaults: Record<string, unknown> } | null;
  defaults: Record<string, unknown>;
  initialBlocks: number;
}

const bad = (msg: string): never => { throw new BadRequestException(msg); };

function str(v: unknown, max: number, what: string, { required = false }: { required?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (required) bad(`${what} is required`);
    return '';
  }
  if (typeof v !== 'string') bad(`${what} must be text`);
  const s = (v as string).trim();
  if (s.length > max) bad(`${what} can be at most ${max} characters`);
  if (/[<>]/.test(s)) bad(`${what} can not contain < or >`);
  return s;
}

function int(v: unknown, min: number, max: number, dflt: number, what: string): number {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${what} must be a number from ${min} to ${max}`);
  return Math.round(v as number);
}

function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T, what: string): T {
  if (v === undefined || v === null || v === '') return dflt;
  if (!allowed.includes(v as T)) bad(`${what} must be one of: ${allowed.join(', ')}`);
  return v as T;
}

interface Ctx {
  count: number;
  keys: Set<string>;
  sectionFields: FieldDef[];
  blockFields: FieldDef[];
  defaults: Record<string, unknown>;
  blockDefaults: Record<string, unknown>;
  repeat: { label: string; initial: number } | null;
}

function claimKey(ctx: Ctx, key: string, what: string): string {
  if (!KEY_RE.test(key)) bad(`${what}: the field name "${key}" must start with a lowercase letter and use only letters and numbers (max 30)`);
  if (RESERVED_FIELD_KEYS.has(key)) bad(`${what}: "${key}" is already used by the platform, pick another field name`);
  if (ctx.keys.has(key)) bad(`${what}: two elements use the field name "${key}"`);
  ctx.keys.add(key);
  return key;
}

function addField(ctx: Ctx, inBlock: boolean, field: FieldDef, dflt?: string): void {
  (inBlock ? ctx.blockFields : ctx.sectionFields).push(field);
  if (dflt) (inBlock ? ctx.blockDefaults : ctx.defaults)[field.key] = dflt;
}

function leafBase(raw: any, ctx: Ctx, what: string): { key: string; label: string; dflt: string } {
  const key = claimKey(ctx, str(raw.key, 30, `${what} field name`, { required: true }), what);
  const label = str(raw.label, 40, `${what} label`) || key;
  const dflt = str(raw.default, 500, `${what} starting text`);
  return { key, label, dflt };
}

function normalize(raw: any, ctx: Ctx, depth: number, inRepeat: boolean, path: string): LayoutNode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${path} is not a valid element`);
  if (depth > MAX_DEPTH) bad(`The layout is nested too deeply (at most ${MAX_DEPTH} levels)`);
  if (++ctx.count > MAX_NODES) bad(`The layout can have at most ${MAX_NODES} elements`);
  const t = raw.t as string;
  const what = `${path} (${t})`;

  const children = (max: number, min = 0): LayoutNode[] => {
    const list = raw.children === undefined ? [] : raw.children;
    if (!Array.isArray(list)) bad(`${what}: children must be a list`);
    if (list.length > max) bad(`${what} can hold at most ${max} elements`);
    if (list.length < min) bad(`${what} needs at least ${min} element`);
    return list.map((c: unknown, i: number) => normalize(c, ctx, depth + 1, inRepeat, `${path}.${i + 1}`));
  };

  switch (t) {
    case 'stack':
      return {
        t, gap: int(raw.gap, 0, 80, 16, `${what} gap`), align: pick(raw.align, ['left', 'center', 'right'], 'left', `${what} alignment`),
        maxWidth: raw.maxWidth ? int(raw.maxWidth, 240, 1600, 0, `${what} width`) : 0,
        children: children(20),
      };
    case 'columns':
      return {
        t, cols: int(raw.cols, 1, 4, 2, `${what} columns`), gap: int(raw.gap, 0, 80, 24, `${what} gap`),
        valign: pick(raw.valign, ['top', 'center', 'bottom'], 'top', `${what} vertical alignment`),
        children: children(12),
      };
    case 'repeat': {
      if (inRepeat) bad('A repeating group can not sit inside another repeating group');
      if (ctx.repeat) bad('A section can have only one repeating group');
      const label = str(raw.label, 30, `${what} item name`) || 'Item';
      const initial = int(raw.initial, 0, 12, 3, `${what} starting items`);
      ctx.repeat = { label, initial };
      const node: LayoutNode = {
        t, label, initial, cols: int(raw.cols, 1, 6, 3, `${what} columns`), gap: int(raw.gap, 0, 80, 24, `${what} gap`),
        card: raw.card === true, align: pick(raw.align, ['left', 'center', 'right'], 'left', `${what} alignment`),
        children: [],
      };
      // the items' elements: one level of containers is enough, and they bind to the ITEM's own fields
      const list = raw.children === undefined ? [] : raw.children;
      if (!Array.isArray(list)) bad(`${what}: children must be a list`);
      if (list.length > 12) bad(`${what} can hold at most 12 elements`);
      node.children = list.map((c: unknown, i: number) => normalize(c, ctx, depth + 1, true, `${path}.${i + 1}`));
      return node;
    }
    case 'heading': {
      const b = leafBase(raw, ctx, what);
      addField(ctx, inRepeat, { key: b.key, label: b.label, kind: 'text', maxLength: 160 }, b.dflt);
      return { t, key: b.key, label: b.label, default: b.dflt, size: pick(raw.size, ['sm', 'md', 'lg', 'xl'], 'md', `${what} size`), align: pick(raw.align, ['inherit', 'left', 'center', 'right'], 'inherit', `${what} alignment`), tag: pick(raw.tag, ['h2', 'h3', 'h4'], 'h2', `${what} tag`) };
    }
    case 'text': {
      const b = leafBase(raw, ctx, what);
      addField(ctx, inRepeat, { key: b.key, label: b.label, kind: 'textarea', maxLength: 1000, rows: 3 }, b.dflt);
      return { t, key: b.key, label: b.label, default: b.dflt, size: pick(raw.size, ['sm', 'md', 'lg'], 'md', `${what} size`), align: pick(raw.align, ['inherit', 'left', 'center', 'right'], 'inherit', `${what} alignment`), muted: raw.muted === true };
    }
    case 'richtext': {
      const b = leafBase(raw, ctx, what);
      addField(ctx, inRepeat, { key: b.key, label: b.label, kind: 'richtext' }, b.dflt);
      return { t, key: b.key, label: b.label, default: b.dflt, align: pick(raw.align, ['inherit', 'left', 'center', 'right'], 'inherit', `${what} alignment`) };
    }
    case 'image': {
      const b = leafBase(raw, ctx, what);
      addField(ctx, inRepeat, { key: b.key, label: b.label, kind: 'image' });
      return {
        t, key: b.key, label: b.label, ratio: pick(raw.ratio, ['auto', 'square', '4:3', '16:9', '3:4'], 'auto', `${what} shape`),
        fit: pick(raw.fit, ['cover', 'contain'], 'cover', `${what} fit`), radius: int(raw.radius, 0, 48, 0, `${what} rounded corners`),
        maxHeight: raw.maxHeight ? int(raw.maxHeight, 100, 1000, 0, `${what} max height`) : 0,
      };
    }
    case 'video': {
      const b = leafBase(raw, ctx, what);
      addField(ctx, inRepeat, { key: b.key, label: b.label, kind: 'video' });
      return { t, key: b.key, label: b.label, ratio: pick(raw.ratio, ['16:9', '4:3', 'square'], '16:9', `${what} shape`) };
    }
    case 'button': {
      const b = leafBase(raw, ctx, what);
      // one element, two fields: the text on the button and where it goes
      const linkKey = claimKey(ctx, `${b.key}Link`, what);
      addField(ctx, inRepeat, { key: b.key, label: `${b.label} (text)`, kind: 'text', maxLength: 40 }, b.dflt || 'Learn more');
      addField(ctx, inRepeat, { key: linkKey, label: `${b.label} (link)`, kind: 'link' });
      return {
        t, key: b.key, label: b.label, default: b.dflt || 'Learn more', link: linkKey,
        style: pick(raw.style, ['solid', 'outline', 'link'], 'solid', `${what} style`), align: pick(raw.align, ['inherit', 'left', 'center', 'right'], 'inherit', `${what} alignment`),
      };
    }
    case 'divider':
      return { t };
    case 'spacer':
      return { t, h: int(raw.h, 0, 200, 24, `${what} height`) };
    default:
      return bad(`${path}: unknown element type "${String(t)}"`);
  }
}

/** Checks a definition's layout tree and derives everything the editor and the storefront need from it. */
export function deriveStoreSectionDef(rawLayout: unknown): DerivedDef {
  const raw = rawLayout as any;
  if (!raw || typeof raw !== 'object' || raw.t !== 'stack') bad('The layout must start with a vertical stack');
  const ctx: Ctx = { count: 0, keys: new Set(), sectionFields: [], blockFields: [], defaults: {}, blockDefaults: {}, repeat: null };
  const layout = normalize(raw, ctx, 1, false, 'layout');
  if (ctx.sectionFields.length > MAX_SECTION_FIELDS) bad(`A section can have at most ${MAX_SECTION_FIELDS} fields`);
  if (ctx.blockFields.length > MAX_BLOCK_FIELDS) bad(`A repeating item can have at most ${MAX_BLOCK_FIELDS} fields`);
  if (ctx.count < 2) bad('Add at least one element to the layout');
  return {
    layout,
    fields: ctx.sectionFields,
    block: ctx.repeat ? { key: 'item', label: ctx.repeat.label, fields: ctx.blockFields, defaults: ctx.blockDefaults } : null,
    defaults: ctx.defaults,
    initialBlocks: ctx.repeat?.initial ?? 0,
  };
}

/** `my.<slug>`: the section key a name turns into (unique per store: the caller adds a number when it is taken). */
export function sectionKeyFor(name: string, suffix = 0): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'section';
  return `my.${slug}${suffix ? `-${suffix}` : ''}`;
}
