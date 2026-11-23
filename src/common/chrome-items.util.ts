import { BadRequestException } from '@nestjs/common';

/**
 * Seller-built items for the storefront "top strip" and the floating contact bar: a plain text, a link/icon, or a link that
 * opens a popup (heading, text, image, a seller-designed QR code, a button, share icons). Everything is validated into a
 * clean stored shape — never trust client objects directly. Theme styling (font, radius, accent) is applied at render time.
 */
export interface ChromeQr {
  data: string;
  fg: string;
  bg: string;
  dot: 'square' | 'rounded' | 'dots';
  eye: 'square' | 'rounded' | 'circle';
  logoUrl: string;
  caption: string;
  frame: boolean;
}

export interface ChromePopup {
  title: string;
  body: string;
  imageUrl: string;
  qr: ChromeQr | null;
  buttonLabel: string;
  buttonUrl: string;
  showShare: boolean;
  footnote: string;
  width: 'sm' | 'md' | 'lg';
  /** 'below' = opens right under the strip item (default for the strip), 'center' = a centred window. */
  placement: 'below' | 'center';
  /** Exact width in px (overrides `width`); 0 = use `width`. */
  widthPx: number;
  /** 'side' = text with the QR/image beside it, 'stack' = everything in one column. */
  layout: 'side' | 'stack';
  /** Order of the parts; a part left out is hidden. */
  order: string[];
  bg: string;
  fg: string;
  /** Corner radius in px; -1 = the theme's own. */
  radius: number;
  /** Space inside in px; -1 = automatic. */
  padding: number;
  titleSize: number;
  bodySize: number;
  align: 'left' | 'center';
  border: boolean;
  shadow: boolean;
}

export interface ChromeItem {
  id: string;
  kind: 'text' | 'link' | 'popup';
  zone: 'left' | 'center' | 'right';
  label: string;
  icon: string;
  iconUrl: string;
  url: string;
  newTab: boolean;
  bg: string;
  fg: string;
  device: 'all' | 'desktop' | 'mobile';
  /** Text size in px; 0 = the strip's. */
  fontSize: number;
  bold: boolean;
  popup: ChromePopup | null;
}

export const POPUP_PARTS = ['title', 'body', 'image', 'qr', 'button', 'share', 'footnote'] as const;
export const DEFAULT_POPUP_ORDER = [...POPUP_PARTS];

function int(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequestException(`${field} must be a number`);
  return Math.min(max, Math.max(min, Math.round(v)));
}

export const MAX_CHROME_ITEMS = 12;
const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_HREF = /^(https?:\/\/\S+|\/(?!\/)\S*|tel:[+0-9 ()\-.]{3,30}|mailto:[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+(\?\S*)?)$/i;
const SAFE_IMAGE = /^(https:\/\/\S+|\/(?!\/)\S*)$/i;

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new BadRequestException(`${field} is not valid`);
  return v as T;
}

function text(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`${field} is too long (max ${max})`);
  return t;
}

function color(v: unknown, field: string): string {
  const t = text(v, field, 7);
  if (t && !HEX.test(t)) throw new BadRequestException(`${field} must be a colour like #1a2b3c`);
  return t;
}

function href(v: unknown, field: string): string {
  const t = text(v, field, 600);
  if (t && !SAFE_HREF.test(t)) throw new BadRequestException(`${field} must start with https://, http://, /, tel: or mailto:`);
  return t;
}

function image(v: unknown, field: string): string {
  const t = text(v, field, 600);
  if (t && !SAFE_IMAGE.test(t)) throw new BadRequestException(`${field} must be an uploaded image or an https link`);
  return t;
}

function sanitizeQr(v: unknown, field: string): ChromeQr | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException(`${field} must be an object`);
  const q = v as Record<string, unknown>;
  const data = text(q.data, `${field}.data`, 800);
  if (!data) return null;
  return {
    data,
    fg: color(q.fg, `${field}.fg`) || '#111111',
    bg: color(q.bg, `${field}.bg`) || '#ffffff',
    dot: oneOf(q.dot, ['square', 'rounded', 'dots'], `${field}.dot`, 'square'),
    eye: oneOf(q.eye, ['square', 'rounded', 'circle'], `${field}.eye`, 'square'),
    logoUrl: image(q.logoUrl, `${field}.logoUrl`),
    caption: text(q.caption, `${field}.caption`, 60),
    frame: q.frame !== false,
  };
}

function sanitizeOrder(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [...DEFAULT_POPUP_ORDER];
  if (!Array.isArray(v) || v.length > POPUP_PARTS.length) throw new BadRequestException(`${field} is not valid`);
  const out: string[] = [];
  for (const k of v) {
    if (typeof k !== 'string' || !(POPUP_PARTS as readonly string[]).includes(k)) throw new BadRequestException(`${field} has an unknown part`);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function sanitizePopup(v: unknown, field: string): ChromePopup | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException(`${field} must be an object`);
  const p = v as Record<string, unknown>;
  return {
    title: text(p.title, `${field}.title`, 120),
    body: text(p.body, `${field}.body`, 2000),
    imageUrl: image(p.imageUrl, `${field}.imageUrl`),
    qr: sanitizeQr(p.qr, `${field}.qr`),
    buttonLabel: text(p.buttonLabel, `${field}.buttonLabel`, 40),
    buttonUrl: href(p.buttonUrl, `${field}.buttonUrl`),
    showShare: p.showShare === true,
    footnote: text(p.footnote, `${field}.footnote`, 300),
    width: oneOf(p.width, ['sm', 'md', 'lg'], `${field}.width`, 'md'),
    placement: oneOf(p.placement, ['below', 'center'], `${field}.placement`, 'below'),
    widthPx: int(p.widthPx, `${field}.widthPx`, 0, 1600, 0),
    layout: oneOf(p.layout, ['side', 'stack'], `${field}.layout`, 'side'),
    order: sanitizeOrder(p.order, `${field}.order`),
    bg: color(p.bg, `${field}.bg`),
    fg: color(p.fg, `${field}.fg`),
    radius: int(p.radius, `${field}.radius`, -1, 200, -1),
    padding: int(p.padding, `${field}.padding`, -1, 200, -1),
    titleSize: int(p.titleSize, `${field}.titleSize`, 0, 120, 0),
    bodySize: int(p.bodySize, `${field}.bodySize`, 0, 48, 0),
    align: oneOf(p.align, ['left', 'center'], `${field}.align`, 'left'),
    border: p.border === true,
    shadow: p.shadow !== false,
  };
}

export function sanitizeChromeItems(input: unknown, field: string): ChromeItem[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new BadRequestException(`${field} must be a list`);
  if (input.length > MAX_CHROME_ITEMS) throw new BadRequestException(`${field} can have at most ${MAX_CHROME_ITEMS} items`);
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException(`${field}[${i}] must be an object`);
    const r = raw as Record<string, unknown>;
    const at = `${field}[${i}]`;
    let id = text(r.id, `${at}.id`, 40).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id || seen.has(id)) id = `i${Date.now().toString(36)}${i}`;
    seen.add(id);
    const kind = oneOf(r.kind, ['text', 'link', 'popup'], `${at}.kind`, 'link');
    const icon = text(r.icon, `${at}.icon`, 32);
    if (icon && !/^[a-z0-9-]+$/.test(icon)) throw new BadRequestException(`${at}.icon is not valid`);
    const item: ChromeItem = {
      id,
      kind,
      zone: oneOf(r.zone, ['left', 'center', 'right'], `${at}.zone`, 'right'),
      label: text(r.label, `${at}.label`, 80),
      icon,
      iconUrl: image(r.iconUrl, `${at}.iconUrl`),
      url: kind === 'link' ? href(r.url, `${at}.url`) : '',
      newTab: r.newTab === true,
      bg: color(r.bg, `${at}.bg`),
      fg: color(r.fg, `${at}.fg`),
      device: oneOf(r.device, ['all', 'desktop', 'mobile'], `${at}.device`, 'all'),
      fontSize: int(r.fontSize, `${at}.fontSize`, 0, 60, 0),
      bold: r.bold === true,
      popup: kind === 'popup' ? sanitizePopup(r.popup, `${at}.popup`) : null,
    };
    if (!item.label && !item.icon && !item.iconUrl) throw new BadRequestException(`${at} needs a label or an icon`);
    return item;
  });
}
