/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

/**
 * The seller-built contact form: a list of fields stored on the `contact_form` section (`settings.fields`).
 * Modelled on Shopify Forms (types, "Email or Phone must be a required field", at most 31 fields) with the
 * WordPress-style freedom to add, remove, reorder and configure every field.
 * A section saved before this existed has no `fields`; `legacyContactFields` rebuilds the old fixed form from its settings.
 */
export const CONTACT_FIELD_TYPES = ['name', 'text', 'email', 'phone', 'textarea', 'number', 'date', 'dropdown', 'radio', 'checkbox'] as const;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];

export interface ContactFormField {
  id: string;
  type: ContactFieldType;
  label: string;
  placeholder?: string;
  required?: boolean;
  width?: 'full' | 'half';
  /** dropdown / radio / checkbox (multiple choice). A checkbox with no options is a single tick box. */
  options?: string[];
}

export const MAX_CONTACT_FIELDS = 31;
const OPTION_TYPES: ContactFieldType[] = ['dropdown', 'radio', 'checkbox'];
const ID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const PHONE_RE = /^\+?[\d\s().-]{5,25}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const bad = (msg: string): never => { throw new BadRequestException(msg); };

/** The old fixed form (Name, Email, optional Phone, Message), rebuilt from a section that has no `fields` yet. */
export function legacyContactFields(settings: Record<string, any> | undefined): ContactFormField[] {
  const s = settings ?? {};
  const text = (k: string, fallback: string) => (typeof s[k] === 'string' && s[k].trim() ? s[k].trim() : fallback);
  const fields: ContactFormField[] = [
    { id: 'name', type: 'name', label: text('nameLabel', 'Name'), required: true, width: 'half' },
    { id: 'email', type: 'email', label: text('emailLabel', 'Email'), required: true, width: 'half' },
  ];
  if (s.showPhone !== false) fields.push({ id: 'phone', type: 'phone', label: text('phoneLabel', 'Phone (optional)'), required: false, width: 'full' });
  fields.push({ id: 'message', type: 'textarea', label: text('messageLabel', 'Message'), required: true, width: 'full' });
  return fields;
}

/** The fields a section really shows: the seller's list, or the old fixed form when the section never had one. */
export function resolveContactFields(settings: Record<string, any> | undefined): ContactFormField[] {
  return Array.isArray(settings?.fields) ? (settings!.fields as ContactFormField[]) : legacyContactFields(settings);
}

/** Checks the seller's field list when a section is saved. */
export function validateContactFieldDefs(input: unknown): void {
  if (!Array.isArray(input)) return bad('settings.fields must be a list');
  if (input.length > MAX_CONTACT_FIELDS) return bad(`A form can have at most ${MAX_CONTACT_FIELDS} fields`);
  const seen = new Set<string>();
  let hasContact = false;
  input.forEach((raw, i) => {
    const p = `settings.fields[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(`${p} must be an object`);
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) return bad(`${p}.id is not valid`);
    if (seen.has(f.id)) return bad(`${p}.id is used twice`);
    seen.add(f.id);
    if (typeof f.type !== 'string' || !(CONTACT_FIELD_TYPES as readonly string[]).includes(f.type)) return bad(`${p}.type is not a supported field type`);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > 60) return bad(`Every field needs a label of up to 60 characters`);
    if (f.placeholder !== undefined && (typeof f.placeholder !== 'string' || f.placeholder.length > 80)) return bad(`${p}.placeholder must be up to 80 characters`);
    if (f.required !== undefined && typeof f.required !== 'boolean') return bad(`${p}.required must be true or false`);
    if (f.width !== undefined && f.width !== 'full' && f.width !== 'half') return bad(`${p}.width must be full or half`);
    const type = f.type as ContactFieldType;
    if (f.options !== undefined) {
      if (!Array.isArray(f.options) || f.options.length > 20) return bad(`${p}.options can have up to 20 choices`);
      const opts = new Set<string>();
      for (const o of f.options) {
        if (typeof o !== 'string' || !o.trim() || o.length > 60) return bad(`Each choice of "${String(f.label)}" must be 1 to 60 characters`);
        if (opts.has(o.trim())) return bad(`"${String(f.label)}" has the choice "${o.trim()}" twice`);
        opts.add(o.trim());
      }
      if (!OPTION_TYPES.includes(type) && f.options.length) return bad(`${p}: only dropdown, radio and checkbox fields have choices`);
    }
    if ((type === 'dropdown' || type === 'radio') && (!Array.isArray(f.options) || f.options.length < 1)) return bad(`"${f.label}" needs at least one choice`);
    if ((type === 'email' || type === 'phone') && f.required === true) hasContact = true;
  });
  // Shopify Forms: every form must collect a way to reach the visitor.
  if (!hasContact) return bad('The form needs an Email or Phone field that is required, so you can answer your visitors');
}

export interface CleanAnswer { id: string; label: string; type: ContactFieldType; value: string }

function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * Checks a visitor's answers against the seller's field list (never against what the visitor claims) and returns
 * the clean answers plus the main contact details used by the inbox (sender name, email, phone, message).
 */
export function validateContactAnswers(defs: ContactFormField[], answers: unknown): {
  clean: CleanAnswer[]; name: string; email: string; phone: string; message: string;
} {
  const byId = new Map<string, unknown>();
  if (Array.isArray(answers)) {
    for (const a of answers) {
      if (a && typeof a === 'object' && typeof (a as any).fieldId === 'string' && !byId.has((a as any).fieldId)) byId.set((a as any).fieldId, (a as any).value);
    }
  }
  const clean: CleanAnswer[] = [];
  for (const def of defs) {
    const raw = byId.get(def.id);
    let value = '';
    if (def.type === 'checkbox') {
      const picked = Array.isArray(raw) ? raw.map(asText).filter(Boolean) : (asText(raw) ? [asText(raw)] : []);
      if (def.options?.length) {
        for (const p of picked) if (!def.options.includes(p)) bad(`"${p}" is not a choice of ${def.label}`);
        value = Array.from(new Set(picked)).join(', ');
      } else {
        value = picked.length && picked[0] !== 'false' ? 'Yes' : '';
      }
    } else {
      value = asText(raw);
    }
    if (!value) {
      if (def.required) bad(`${def.label} is required`);
      continue;
    }
    switch (def.type) {
      case 'name': if (value.length > 80) bad(`${def.label} is too long`); break;
      case 'text': if (value.length > 300) bad(`${def.label} is too long`); break;
      case 'textarea': if (value.length > 3000) bad(`${def.label} is too long`); break;
      case 'email': if (value.length > 120 || !EMAIL_RE.test(value)) bad('Enter a valid email address'); value = value.toLowerCase(); break;
      case 'phone': if (!PHONE_RE.test(value)) bad('Enter a valid phone number'); break;
      case 'number': if (value.length > 30 || !Number.isFinite(Number(value))) bad(`${def.label} must be a number`); break;
      case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) bad(`${def.label} must be a date`); break;
      case 'dropdown':
      case 'radio': if (!def.options?.includes(value)) bad(`"${value}" is not a choice of ${def.label}`); break;
      default: break;
    }
    clean.push({ id: def.id, label: def.label, type: def.type, value });
  }
  const first = (type: ContactFieldType) => clean.find(a => a.type === type)?.value ?? '';
  return { clean, name: first('name'), email: first('email'), phone: first('phone'), message: first('textarea') };
}
