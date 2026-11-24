/* eslint-disable prettier/prettier */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Pure helpers for the Sales Ops → Brevo marketing sync (see sales-brevo.service.ts): what we send to Brevo for a lead,
 * the consent-confirmation link, the CSV export and the Brevo webhook payload. No database, no network.
 */

export const CONSENT_STATUSES = ['none', 'asked', 'granted', 'withdrawn'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];
export const CONSENT_SOURCES = ['demo_form', 'contact_form', 'manual', 'email_confirm', 'brevo'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export interface MarketingConsent {
  status: ConsentStatus;
  at: Date | null;
  source: ConsentSource | null;
  note: string | null;
  askedAt: Date | null;
  ip: string | null;
}
export interface BrevoSyncState {
  syncedAt: Date | null;
  error: string | null;
  pending: boolean;
}

export const defaultConsent = (): MarketingConsent => ({ status: 'none', at: null, source: null, note: null, askedAt: null, ip: null });
export const defaultBrevoState = (): BrevoSyncState => ({ syncedAt: null, error: null, pending: false });

/** The consent as the browser sees it: never the IP address. Old leads (saved before consent existed) read as 'none'. */
export function consentView(c: Partial<MarketingConsent> | null | undefined) {
  const d = { ...defaultConsent(), ...(c ?? {}) };
  return { status: d.status, at: d.at, source: d.source, note: d.note, askedAt: d.askedAt };
}
export function brevoView(b: Partial<BrevoSyncState> | null | undefined): BrevoSyncState {
  const d = { ...defaultBrevoState(), ...(b ?? {}) };
  return { syncedAt: d.syncedAt, error: d.error, pending: !!d.pending };
}

/** Lead fields we send to Brevo: a change to any of them (on a consented lead) queues a re-sync. */
export const BREVO_SYNCED_FIELDS = ['name', 'businessName', 'city', 'phone', 'email', 'source', 'stage'] as const;

/** Contact attributes created in Brevo on connect (FIRSTNAME, LASTNAME and WHATSAPP exist in every account). */
export const BREVO_CUSTOM_ATTRIBUTES = ['COMPANY', 'CITY', 'LEAD_STAGE', 'LEAD_SOURCE', 'LEAD_CAMPAIGN'] as const;
export const BREVO_FOLDER_NAME = 'Solvexo';
export const BREVO_LIST_NAME = 'Solvexo – Sales leads';

/** "Ayesha Khan Niazi" → first "Ayesha", last "Khan Niazi". */
export function splitName(name: string | null | undefined): { first: string; last: string } {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/**
 * A phone number in the form Brevo's WHATSAPP attribute wants. Numbers that look Pakistani (0300 1234567, 3001234567,
 * 92300…, 0092300…) become +92XXXXXXXXXX; anything else is returned as given (trimmed). Null when there is no number.
 */
export function normalizeWhatsApp(phone: string | null | undefined): string | null {
  const raw = String(phone ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('0092') && digits.length === 14) return `+${digits.slice(2)}`;
  if (digits.startsWith('92') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('03') && digits.length === 11) return `+92${digits.slice(1)}`;
  if (digits.startsWith('3') && digits.length === 10) return `+92${digits}`;
  return raw;
}

export interface BrevoLeadInput {
  name?: string | null;
  businessName?: string | null;
  city?: string | null;
  phone?: string | null;
  stage?: string | null;
  source?: string | null;
  utm?: { campaign?: string | null } | null;
}

/** The Brevo contact attributes for a lead. Cleared fields are sent as '' so Brevo forgets the old value; WHATSAPP is left out when there is no number. */
export function brevoAttributes(lead: BrevoLeadInput): Record<string, string> {
  const { first, last } = splitName(lead.name);
  const out: Record<string, string> = {
    FIRSTNAME: first,
    LASTNAME: last,
    COMPANY: (lead.businessName ?? '').trim(),
    CITY: (lead.city ?? '').trim(),
    LEAD_STAGE: lead.stage ?? '',
    LEAD_SOURCE: lead.source ?? '',
    LEAD_CAMPAIGN: (lead.utm?.campaign ?? '').trim(),
  };
  const wa = normalizeWhatsApp(lead.phone);
  if (wa) out.WHATSAPP = wa;
  return out;
}

// ── CSV export ──────────────────────────────────────────────────────────────

export const BREVO_CSV_COLUMNS = ['EMAIL', 'FIRSTNAME', 'LASTNAME', 'COMPANY', 'CITY', 'WHATSAPP', 'LEAD_STAGE', 'LEAD_SOURCE', 'LEAD_CAMPAIGN', 'CONSENT_DATE', 'CONSENT_SOURCE'] as const;

/**
 * One CSV cell, safe to open in a spreadsheet: a value starting with = + - @ (or a tab / CR) gets a leading ' so it is
 * never run as a formula. A plain international phone number (+ and digits only) is left alone: it cannot be a formula
 * and Brevo needs the + to import it.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d{6,15}$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface BrevoCsvLead extends BrevoLeadInput {
  email?: string | null;
  marketingConsent?: Partial<MarketingConsent> | null;
}

/** The Brevo import file: one row per lead (callers pass only consented leads with an email). */
export function buildBrevoCsv(leads: BrevoCsvLead[]): string {
  const rows = [BREVO_CSV_COLUMNS.join(',')];
  for (const l of leads) {
    const a = brevoAttributes(l);
    const at = l.marketingConsent?.at ? new Date(l.marketingConsent.at) : null;
    rows.push([
      l.email ?? '', a.FIRSTNAME, a.LASTNAME, a.COMPANY, a.CITY, a.WHATSAPP ?? '', a.LEAD_STAGE, a.LEAD_SOURCE, a.LEAD_CAMPAIGN,
      at && !Number.isNaN(at.getTime()) ? at.toISOString().slice(0, 10) : '', l.marketingConsent?.source ?? '',
    ].map(csvCell).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}

/** solvexo-leads-brevo-2026-11-24.csv */
export const brevoCsvFilename = (now = new Date()) => `solvexo-leads-brevo-${now.toISOString().slice(0, 10)}.csv`;

// ── Consent confirmation link ─────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
export const CONSENT_TOKEN_DAYS = 60;
const PURPOSE = 'sales_marketing_consent';

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/**
 * The "Yes, keep me posted" link's token: a signed, stateless "lead X agreed" valid for 60 days. Same scheme as the
 * repo's other public tokens (HMAC-SHA256 with JWT_SECRET) with its own purpose, so no other signed link can be used as one.
 */
export function signConsentToken(leadId: string, now = Date.now(), days = CONSENT_TOKEN_DAYS): string {
  const body = b64(JSON.stringify({ l: String(leadId), e: now + days * DAY, p: PURPOSE }));
  return `${body}.${b64(createHmac('sha256', secret()).update(body).digest())}`;
}

/** `{ leadId, issuedAt }`, or null when the token is malformed, forged, expired or made for something else. */
export function verifyConsentToken(token: string, now = Date.now()): { leadId: string; issuedAt: Date } | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.p !== PURPOSE || typeof p.l !== 'string' || !/^[a-f0-9]{24}$/i.test(p.l) || typeof p.e !== 'number' || p.e < now) return null;
    return { leadId: p.l, issuedAt: new Date(p.e - CONSENT_TOKEN_DAYS * DAY) };
  } catch { return null; }
}

/** Constant-time string comparison (different lengths are simply unequal). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── Brevo webhook ─────────────────────────────────────────────────────────────

/** Brevo events that mean "stop emailing this person". */
const WITHDRAW_EVENTS: Record<string, 'unsubscribed' | 'spam' | 'hard_bounce'> = {
  unsubscribed: 'unsubscribed', unsubscribe: 'unsubscribed', spam: 'spam', complaint: 'spam', hardbounce: 'hard_bounce',
};
export type WithdrawEvent = 'unsubscribed' | 'spam' | 'hard_bounce';
const MAX_EVENTS = 100;

/**
 * The consent-withdrawing events in a Brevo webhook body (one event object or an array of them): lower-cased email
 * and the event kind, deduplicated, at most 100. Everything else (opens, clicks, deliveries) is ignored.
 */
export function parseBrevoWebhook(body: unknown): { email: string; event: WithdrawEvent }[] {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const out: { email: string; event: WithdrawEvent }[] = [];
  const seen = new Set<string>();
  for (const e of list.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object') continue;
    const kind = WITHDRAW_EVENTS[String((e as any).event ?? '').toLowerCase().replace(/[^a-z]/g, '')];
    const email = typeof (e as any).email === 'string' ? (e as any).email.trim().toLowerCase() : '';
    if (!kind || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, event: kind });
  }
  return out;
}

export const WITHDRAW_ACTIVITY: Record<WithdrawEvent, string> = {
  unsubscribed: 'Unsubscribed in Brevo',
  spam: 'Unsubscribed in Brevo (marked an email as spam)',
  hard_bounce: 'Unsubscribed in Brevo (the email address bounced)',
};

/** A Brevo error for people to read: at most 300 characters, the API key never in it. */
export function brevoErrorText(status: number | null, message: unknown, apiKey?: string | null): string {
  let m = typeof message === 'string' ? message : message == null ? '' : JSON.stringify(message);
  if (apiKey && apiKey.length >= 4) m = m.split(apiKey).join('••••');
  m = m.replace(/xkeysib-[A-Za-z0-9-]+/g, '••••').replace(/\s+/g, ' ').trim();
  const text = status ? `Brevo ${status}${m ? `: ${m}` : ''}` : m || 'Could not reach Brevo';
  return text.slice(0, 300);
}
