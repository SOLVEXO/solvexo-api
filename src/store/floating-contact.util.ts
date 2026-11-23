import { BadRequestException } from '@nestjs/common';
import { sanitizeChromeItems, type ChromeItem } from '../common/chrome-items.util';

/** Floating contact bar shown on every storefront theme (call / WhatsApp / social icons). */
export interface FloatingContactConfig {
  enabled: boolean;
  position: 'right' | 'left';
  vertical: 'top' | 'middle' | 'bottom';
  size: 'sm' | 'md' | 'lg';
  style: 'brand' | 'theme';
  showLabels: boolean;
  device: 'all' | 'desktop' | 'mobile';
  phone: string;
  phoneLabel: string;
  whatsapp: string;
  whatsappMessage: string;
  whatsappLabel: string;
  email: string;
  emailLabel: string;
  facebook: string;
  instagram: string;
  tiktok: string;
  youtube: string;
  x: string;
  snapchat: string;
  linkedin: string;
  /** Seller-built buttons (any link or popup) shown after the built-in ones. */
  items: ChromeItem[];
  /** Round corner button instead of the flush edge stack, with an optional speech bubble ("Need help? Chat with us"). */
  shape: 'flush' | 'round';
  bubbleText: string;
  /** Overrides the colours of the built-in buttons (null = brand/theme colour). */
  customBg: string;
  customFg: string;
  /** Exact button size in px (0 = use `size`). */
  sizePx: number;
  /** Distance from the screen edge in px. */
  edgeOffset: number;
  /** Space between buttons in px (-1 = automatic). */
  gapPx: number;
}

const URL_KEYS = ['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'snapchat', 'linkedin'] as const;

export const DEFAULT_FLOATING_CONTACT: FloatingContactConfig = {
  enabled: false, position: 'right', vertical: 'middle', size: 'md', style: 'brand', showLabels: true, device: 'all',
  phone: '', phoneLabel: '', whatsapp: '', whatsappMessage: '', whatsappLabel: '', email: '', emailLabel: '',
  facebook: '', instagram: '', tiktok: '', youtube: '', x: '', snapchat: '', linkedin: '',
  items: [], shape: 'flush', bubbleText: '', customBg: '', customFg: '', sizePx: 0, edgeOffset: 0, gapPx: -1,
};

function whole(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequestException(`floatingContact.${field} must be a number`);
  return Math.min(max, Math.max(min, Math.round(v)));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new BadRequestException(`floatingContact.${field} is not valid`);
  return v as T;
}

function text(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new BadRequestException(`floatingContact.${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new BadRequestException(`floatingContact.${field} is too long (max ${max})`);
  return t;
}

function hex(v: unknown, field: string): string {
  const t = text(v, field, 7);
  if (t && !/^#[0-9a-fA-F]{6}$/.test(t)) throw new BadRequestException(`floatingContact.${field} must be a colour like #1a2b3c`);
  return t;
}

function phoneOf(v: unknown, field: string): string {
  const t = text(v, field, 30);
  if (!t) return '';
  if (!/^\+?[0-9 ()\-.]{5,30}$/.test(t)) throw new BadRequestException(`floatingContact.${field} must be a phone number`);
  return t;
}

function httpsUrl(v: unknown, field: string): string {
  const t = text(v, field, 500);
  if (!t) return '';
  let u: URL;
  try { u = new URL(t); } catch { throw new BadRequestException(`floatingContact.${field} must be a full https link`); }
  if (u.protocol !== 'https:') throw new BadRequestException(`floatingContact.${field} must start with https://`);
  return u.toString();
}

/** Validates the seller's input into a clean stored config. Never trust client objects directly. */
export function normalizeFloatingContact(input: unknown): FloatingContactConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('floatingContact must be an object');
  const b = input as Record<string, unknown>;
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') throw new BadRequestException('floatingContact.enabled must be true or false');
  if (b.showLabels !== undefined && typeof b.showLabels !== 'boolean') throw new BadRequestException('floatingContact.showLabels must be true or false');
  const email = text(b.email, 'email', 200);
  if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new BadRequestException('floatingContact.email is not a valid email');
  const out: FloatingContactConfig = {
    enabled: b.enabled === true,
    position: oneOf(b.position, ['right', 'left'], 'position', 'right'),
    vertical: oneOf(b.vertical, ['top', 'middle', 'bottom'], 'vertical', 'middle'),
    size: oneOf(b.size, ['sm', 'md', 'lg'], 'size', 'md'),
    style: oneOf(b.style, ['brand', 'theme'], 'style', 'brand'),
    showLabels: b.showLabels !== false,
    device: oneOf(b.device, ['all', 'desktop', 'mobile'], 'device', 'all'),
    phone: phoneOf(b.phone, 'phone'),
    phoneLabel: text(b.phoneLabel, 'phoneLabel', 40),
    whatsapp: phoneOf(b.whatsapp, 'whatsapp'),
    whatsappMessage: text(b.whatsappMessage, 'whatsappMessage', 300),
    whatsappLabel: text(b.whatsappLabel, 'whatsappLabel', 40),
    email,
    emailLabel: text(b.emailLabel, 'emailLabel', 40),
    facebook: '', instagram: '', tiktok: '', youtube: '', x: '', snapchat: '', linkedin: '',
    items: sanitizeChromeItems(b.items, 'floatingContact.items'),
    shape: oneOf(b.shape, ['flush', 'round'], 'shape', 'flush'),
    bubbleText: text(b.bubbleText, 'bubbleText', 60),
    customBg: hex(b.customBg, 'customBg'),
    customFg: hex(b.customFg, 'customFg'),
    sizePx: whole(b.sizePx, 'sizePx', 0, 140, 0),
    edgeOffset: whole(b.edgeOffset, 'edgeOffset', 0, 200, 0),
    gapPx: whole(b.gapPx, 'gapPx', -1, 80, -1),
  };
  for (const k of URL_KEYS) out[k] = httpsUrl(b[k], k);
  return out;
}
