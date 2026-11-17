import { BadRequestException } from '@nestjs/common';

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
}

const URL_KEYS = ['facebook', 'instagram', 'tiktok', 'youtube', 'x', 'snapchat', 'linkedin'] as const;

export const DEFAULT_FLOATING_CONTACT: FloatingContactConfig = {
  enabled: false, position: 'right', vertical: 'middle', size: 'md', style: 'brand', showLabels: true, device: 'all',
  phone: '', phoneLabel: '', whatsapp: '', whatsappMessage: '', whatsappLabel: '', email: '', emailLabel: '',
  facebook: '', instagram: '', tiktok: '', youtube: '', x: '', snapchat: '', linkedin: '',
};

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
  };
  for (const k of URL_KEYS) out[k] = httpsUrl(b[k], k);
  return out;
}
