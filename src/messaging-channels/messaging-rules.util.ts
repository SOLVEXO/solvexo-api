/* eslint-disable prettier/prettier */
import { normalizePhone } from '../cod-protection/cod-risk.util';

/**
 * Marketing messaging over WhatsApp (and, later, SMS): pure rules. Meta's policy is the benchmark: marketing messages go out only as
 * approved templates, only to people who explicitly opted in to THAT channel, a STOP is honoured at once, and a new number is limited
 * to a daily number of unique contacts. No database or network here.
 */

export const CHANNELS = ['whatsapp', 'sms'] as const;
export type Channel = (typeof CHANNELS)[number];

/** New WhatsApp Business numbers start at about 1,000 unique contacts per 24 hours (Meta messaging tier 1). Per-store default, seller can lower it. */
export const DEFAULT_DAILY_LIMIT = 1000;
export const MAX_BATCH = 50;

/** One comparable key for a contact: digits with country code (Pakistani formats collapse), same as the COD phone key. */
export const contactKey = (raw: unknown): string | null => normalizePhone(raw);

export interface ConsentLike { status?: string | null }
/** Explicit opt-in recorded for THIS channel and not withdrawn. Anything else (no record, opted out) is a no. */
export const hasConsent = (c: ConsentLike | null | undefined): boolean => c?.status === 'opted_in';

const STOP_WORDS = new Set(['stop', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out', 'remove me', 'unsub']);
/** An inbound reply that withdraws consent (English keywords, any case, ignoring punctuation). */
export function isStopKeyword(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const t = text.toLowerCase().replace(/[.!?,"'`]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 20 && STOP_WORDS.has(t);
}

/** How many more unique contacts may be started now, given today's limit and how many were already contacted in the last 24 h. */
export function remainingToday(limit: number, contactedLast24h: number): number {
  return Math.max(0, Math.floor(limit) - Math.max(0, Math.floor(contactedLast24h)));
}

/** Splits ids into batches of at most `size`. */
export function chunk<T>(items: T[], size = MAX_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const NAME_RE = /^[a-z0-9_]{1,200}$/;
const LANG_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

export interface TemplateInput { name: string; language: string; bodyText: string; examples: string[] }

/**
 * Seller input check for a marketing template before it is submitted to Meta: lowercase name, language code, body up to 1024 characters,
 * placeholders {{1}}, {{2}}... numbered without gaps and each with an example value. (Meta's exact formatting rules are only partly
 * known here: Meta stays the final judge and a rejection reason is shown to the seller.)
 */
export function validateTemplateInput(t: TemplateInput): string | null {
  if (!NAME_RE.test(t.name ?? '')) return 'Template name: lowercase letters, numbers and underscores only';
  if (!LANG_RE.test(t.language ?? '')) return 'Language must look like en_US or ur';
  const body = (t.bodyText ?? '').trim();
  if (!body) return 'Write the message text';
  if (body.length > 1024) return 'The message text can be at most 1024 characters';
  const nums = [...body.matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => Number(m[1]));
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (uniq.some((n, i) => n !== i + 1)) return 'Placeholders must be numbered {{1}}, {{2}}, ... without gaps';
  if (/{{[^}]*[^}\d\s][^}]*}}/.test(body)) return 'Placeholders must be numbers like {{1}}';
  if ((t.examples ?? []).length !== uniq.length) return `Give one example value for each of the ${uniq.length} placeholder(s)`;
  if ((t.examples ?? []).some((e) => typeof e !== 'string' || !e.trim() || e.length > 200)) return 'Example values cannot be empty';
  return null;
}

export const templateParamCount = (bodyText: string): number => new Set([...(bodyText ?? '').matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => m[1])).size;

/** A marketing campaign may only use an approved template (Meta refuses anything else; we refuse before spending a send). */
export const canSendTemplate = (status: string | null | undefined): boolean => String(status ?? '').toUpperCase() === 'APPROVED';

/** A send that failed for a reason that may pass (rate limit, provider or network trouble) is retried; a refused number or content is not. */
export const isTransientSendError = (error: unknown): boolean => /\b(429|5\d\d)\b|timeout|timed out|ETIMEDOUT|ECONN|fetch failed|rate limit|temporar/i.test(String(error ?? ''));

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped_no_consent' | 'skipped_opted_out' | 'skipped_invalid';
const RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/** A delivery report may only move a message forward (sent -> delivered -> read); a late or repeated report never moves it back. */
export function advanceStatus(current: string, incoming: string): string {
  if (incoming === 'failed') return current === 'delivered' || current === 'read' ? current : 'failed';
  const a = RANK[current]; const b = RANK[incoming];
  if (a === undefined || b === undefined) return current;
  return b > a ? incoming : current;
}

export interface CampaignCounts { queued: number; sent: number; delivered: number; read: number; failed: number; skipped: number }
/** Counts per message status -> the campaign figures shown to the seller (a read message was also delivered, a delivered one was also sent). */
export function countsFromStatuses(byStatus: Record<string, number>): CampaignCounts & { total: number } {
  const g = (k: string) => byStatus[k] ?? 0;
  const read = g('read'); const delivered = g('delivered') + read; const sent = g('sent') + delivered;
  const skipped = g('skipped_no_consent') + g('skipped_opted_out') + g('skipped_invalid') + g('canceled');
  const queued = g('queued') + g('sending');
  const failed = g('failed');
  return { queued, sent, delivered, read, failed, skipped, total: queued + sent + failed + skipped };
}
