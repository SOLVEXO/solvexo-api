/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

/**
 * The seller-built form: a list of fields stored on the `contact_form` section (`settings.fields`) plus a few form-level
 * settings (name, what happens after sending, who is emailed, the automatic reply).
 * Modelled on Shopify Forms (types, "Email or Phone must be a required field", at most 31 fields) with the
 * WordPress/Elementor freedom to add, remove, reorder and configure every field and to show a field only when
 * another answer matches (conditional logic).
 * A section saved before this existed has no `fields`; `legacyContactFields` rebuilds the old fixed form from its settings.
 * The web copy (solvexo-web/.../core/forms/contactFormFields.ts) must be kept in step by hand.
 */
export const CONTACT_FIELD_TYPES = [
  'name', 'text', 'email', 'phone', 'textarea', 'number', 'date', 'time', 'url',
  'dropdown', 'radio', 'checkbox', 'consent', 'rating', 'country', 'hidden', 'heading', 'paragraph', 'step', 'file',
] as const;
export type ContactFieldType = (typeof CONTACT_FIELD_TYPES)[number];

export const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'filled', 'empty'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface ContactCondition { fieldId: string; op: ConditionOp; value?: string }

export interface ContactFormField {
  id: string;
  type: ContactFieldType;
  /** The question; for a heading / paragraph the text itself; for a consent box the sentence next to the tick. */
  label: string;
  placeholder?: string;
  helpText?: string;
  defaultValue?: string;
  required?: boolean;
  width?: 'full' | 'half' | 'third' | 'quarter';
  /** dropdown / radio / checkbox (multiple choice). A checkbox with no options is a single tick box. */
  options?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** Shown instead of the standard message when this field is missing or wrong. */
  errorMessage?: string;
  /** Show this field only when an EARLIER field's answer matches. */
  showIf?: ContactCondition;
  /** file: which kinds of file are accepted, and the size limit in MB (at most 10). */
  fileKinds?: 'images' | 'documents' | 'both';
  maxSizeMb?: number;
  /** consent: when ticked and the visitor gave an email, add them to the store's email marketing list. */
  subscribes?: boolean;
}

/** The file extensions a form's file field accepts (images and common documents only: no svg, html or programs). */
export const FILE_EXTENSIONS: Record<'images' | 'documents' | 'both', string[]> = {
  images: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'],
  both: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv'],
};
export const MAX_FILE_MB = 10;
export const UPLOAD_ID_RE = /^[a-f0-9]{24}$/i;

export const MAX_CONTACT_FIELDS = 31;
const OPTION_TYPES: ContactFieldType[] = ['dropdown', 'radio', 'checkbox'];
/** Fields that show text but collect nothing. */
/** `step` starts a new page of a multi-step form; it only holds the page title. */
const STATIC_TYPES: ContactFieldType[] = ['heading', 'paragraph', 'step'];
const ID_RE = /^[A-Za-z0-9_-]{2,40}$/;
const PHONE_RE = /^\+?[\d\s().-]{5,25}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WIDTHS = ['full', 'half', 'third', 'quarter'];

const bad = (msg: string): never => { throw new BadRequestException(msg); };

const labelLimit = (type: ContactFieldType) => (type === 'paragraph' ? 500 : type === 'consent' ? 300 : type === 'heading' ? 120 : 60);

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

const wholeNumber = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

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
    if (typeof f.type !== 'string' || !(CONTACT_FIELD_TYPES as readonly string[]).includes(f.type)) return bad(`${p}.type is not a supported field type`);
    const type = f.type as ContactFieldType;
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > labelLimit(type)) return bad(`Every field needs a label of up to ${labelLimit(type)} characters`);
    for (const [k, max] of [['placeholder', 80], ['helpText', 150], ['defaultValue', 200], ['errorMessage', 120]] as const) {
      if (f[k] !== undefined && (typeof f[k] !== 'string' || (f[k] as string).length > max)) return bad(`${p}.${k} must be up to ${max} characters`);
    }
    if (f.required !== undefined && typeof f.required !== 'boolean') return bad(`${p}.required must be true or false`);
    if (f.width !== undefined && !WIDTHS.includes(f.width as string)) return bad(`${p}.width must be full, half, third or quarter`);
    for (const k of ['minLength', 'maxLength'] as const) {
      if (f[k] !== undefined && !wholeNumber(f[k], 0, 3000)) return bad(`${p}.${k} must be a whole number up to 3000`);
    }
    if (f.minLength !== undefined && f.maxLength !== undefined && (f.minLength as number) > (f.maxLength as number)) return bad(`"${f.label}": the minimum length is above the maximum`);
    for (const k of ['min', 'max'] as const) {
      if (f[k] !== undefined && (typeof f[k] !== 'number' || !Number.isFinite(f[k] as number))) return bad(`${p}.${k} must be a number`);
    }
    if (f.min !== undefined && f.max !== undefined && (f.min as number) > (f.max as number)) return bad(`"${f.label}": the minimum is above the maximum`);
    if (STATIC_TYPES.includes(type) && f.required) return bad(`"${f.label}" only shows text, so it cannot be required`);
    if (f.fileKinds !== undefined && !['images', 'documents', 'both'].includes(f.fileKinds as string)) return bad(`${p}.fileKinds must be images, documents or both`);
    if (f.maxSizeMb !== undefined && !wholeNumber(f.maxSizeMb, 1, MAX_FILE_MB)) return bad(`${p}.maxSizeMb must be a whole number from 1 to ${MAX_FILE_MB}`);
    if (f.subscribes !== undefined && typeof f.subscribes !== 'boolean') return bad(`${p}.subscribes must be true or false`);
    if (f.subscribes === true && type !== 'consent') return bad(`"${f.label}": only a consent tick box can sign visitors up for email marketing`);

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

    if (f.showIf !== undefined) {
      const c = f.showIf as Record<string, unknown>;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return bad(`${p}.showIf must be an object`);
      // Only an earlier field can decide: no loops, and the visitor always sees the cause before the effect.
      if (typeof c.fieldId !== 'string' || !seen.has(c.fieldId)) return bad(`"${f.label}" can only depend on a field above it`);
      if (typeof c.op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(c.op)) return bad(`${p}.showIf.op is not valid`);
      if (c.value !== undefined && (typeof c.value !== 'string' || c.value.length > 200)) return bad(`${p}.showIf.value must be up to 200 characters`);
      if ((c.op === 'equals' || c.op === 'not_equals' || c.op === 'contains') && !(typeof c.value === 'string' && c.value.length)) return bad(`"${f.label}": choose the answer that shows this field`);
    }
    seen.add(f.id);
    // The contact field that lets the seller answer must always be on the form.
    if ((type === 'email' || type === 'phone') && f.required === true && f.showIf === undefined) hasContact = true;
  });
  // Shopify Forms: every form must collect a way to reach the visitor.
  if (!hasContact) return bad('The form needs an Email or Phone field that is required (and always shown), so you can answer your visitors');
}

const SUCCESS_ACTIONS = ['message', 'redirect'];
const DISPLAY_MODES = ['inline', 'popup'];

/** Parses the "who gets an email" setting: a comma / line separated list of addresses. */
export function parseNotifyEmails(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return Array.from(new Set(value.split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))).slice(0, 5);
}

/** An address a visitor may be sent to after the form: https, or a path on the store itself. */
export function isSafeRedirect(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > 300) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}

/** Checks the whole `contact_form` section when it is saved: the field list and the form-level settings. */
export function validateContactFormSettings(settings: Record<string, any>): void {
  if (settings.fields !== undefined) validateContactFieldDefs(settings.fields);
  const text = (k: string, max: number) => {
    if (settings[k] !== undefined && (typeof settings[k] !== 'string' || settings[k].length > max)) bad(`settings.${k} must be up to ${max} characters`);
  };
  text('formName', 60); text('popupButtonLabel', 40); text('autoReplySubject', 120); text('autoReplyBody', 2000);
  if (settings.successAction !== undefined && !SUCCESS_ACTIONS.includes(settings.successAction)) bad('settings.successAction must be message or redirect');
  if (settings.successAction === 'redirect' && !isSafeRedirect(settings.redirectUrl)) bad('Enter the address visitors are sent to (https://… or a path starting with /)');
  if (settings.redirectUrl !== undefined && settings.redirectUrl !== '' && !isSafeRedirect(settings.redirectUrl)) bad('The redirect address must start with https:// or /');
  if (settings.notifyEmails !== undefined) {
    if (typeof settings.notifyEmails !== 'string' || settings.notifyEmails.length > 600) bad('settings.notifyEmails is too long');
    const raw = String(settings.notifyEmails).split(/[\s,;]+/).map(e => e.trim()).filter(Boolean);
    if (raw.length > 5) bad('You can email up to 5 addresses');
    for (const e of raw) if (!EMAIL_RE.test(e) || e.length > 120) bad(`"${e}" is not a valid email address`);
  }
  if (settings.display !== undefined && !DISPLAY_MODES.includes(settings.display)) bad('settings.display must be inline or popup');
  if (settings.autoReplyEnabled !== undefined && typeof settings.autoReplyEnabled !== 'boolean') bad('settings.autoReplyEnabled must be true or false');
  if (settings.captcha !== undefined && typeof settings.captcha !== 'boolean') bad('settings.captcha must be true or false');
}

export interface CleanAnswer { id: string; label: string; type: ContactFieldType; value: string }

function asText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** Does a field's condition hold, given the answers of the fields above it (an unanswered field counts as empty)? */
export function conditionHolds(cond: ContactCondition | undefined, answers: Map<string, string>): boolean {
  if (!cond) return true;
  const have = (answers.get(cond.fieldId) ?? '').toLowerCase();
  const want = String(cond.value ?? '').trim().toLowerCase();
  switch (cond.op) {
    case 'filled': return have.length > 0;
    case 'empty': return have.length === 0;
    case 'equals': return have === want || have.split(', ').includes(want);
    case 'not_equals': return have !== want && !have.split(', ').includes(want);
    case 'contains': return have.includes(want);
    default: return true;
  }
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string | null {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    const name = regionNames.of(code.toUpperCase());
    return name && name !== code.toUpperCase() ? name : null;
  } catch { return null; }
}

/**
 * Checks a visitor's answers against the seller's field list (never against what the visitor claims) and returns
 * the clean answers plus the main contact details used by the inbox (sender name, email, phone, message).
 * A field hidden by its condition is neither required nor stored.
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
  const shown = new Map<string, string>(); // answers of the fields that were visible, for the conditions below them
  for (const def of defs) {
    if (STATIC_TYPES.includes(def.type)) continue;
    if (!conditionHolds(def.showIf, shown)) continue;
    const fail = (msg: string): never => bad(def.errorMessage?.trim() || msg);
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
    } else if (def.type === 'consent') {
      const t = asText(raw);
      value = t && t !== 'false' ? 'Yes' : '';
    } else {
      value = asText(raw);
    }
    if (!value) {
      if (def.required) fail(def.type === 'consent' ? `Please tick: ${def.label}` : `${def.label} is required`);
      continue;
    }
    switch (def.type) {
      case 'name': if (value.length > 80) fail(`${def.label} is too long`); break;
      case 'text':
      case 'textarea': {
        const max = Math.min(def.maxLength ?? (def.type === 'text' ? 300 : 3000), def.type === 'text' ? 300 : 3000);
        if (value.length > max) fail(`${def.label} is too long (up to ${max} characters)`);
        if (def.minLength && value.length < def.minLength) fail(`${def.label} needs at least ${def.minLength} characters`);
        break;
      }
      case 'email': if (value.length > 120 || !EMAIL_RE.test(value)) fail('Enter a valid email address'); value = value.toLowerCase(); break;
      case 'phone': if (!PHONE_RE.test(value)) fail('Enter a valid phone number'); break;
      case 'number': {
        const n = Number(value);
        if (value.length > 30 || !Number.isFinite(n)) fail(`${def.label} must be a number`);
        if (def.min !== undefined && n < def.min) fail(`${def.label} must be ${def.min} or more`);
        if (def.max !== undefined && n > def.max) fail(`${def.label} must be ${def.max} or less`);
        break;
      }
      case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) fail(`${def.label} must be a date`); break;
      case 'time': if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`${def.label} must be a time`); break;
      case 'url': {
        let ok = value.length <= 300;
        try { const u = new URL(value); ok = ok && (u.protocol === 'https:' || u.protocol === 'http:'); } catch { ok = false; }
        if (!ok) fail(`${def.label} must be a web address (https://…)`);
        break;
      }
      case 'rating': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 5) fail(`${def.label} must be 1 to 5`);
        value = `${n} / 5`;
        break;
      }
      case 'country': {
        const name = /^[A-Za-z]{2}$/.test(value) ? countryName(value) : null;
        if (!name) fail(`Choose a country for ${def.label}`);
        value = name as string;
        break;
      }
      case 'hidden': if (value.length > 300) value = value.slice(0, 300); break;
      case 'file': if (!UPLOAD_ID_RE.test(value)) fail('Attach the file again'); break;
      case 'dropdown':
      case 'radio': if (!def.options?.includes(value)) bad(`"${value}" is not a choice of ${def.label}`); break;
      default: break;
    }
    clean.push({ id: def.id, label: def.label, type: def.type, value });
    shown.set(def.id, value);
  }
  const first = (type: ContactFieldType) => clean.find(a => a.type === type)?.value ?? '';
  return { clean, name: first('name'), email: first('email'), phone: first('phone'), message: first('textarea') };
}
