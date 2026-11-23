/* eslint-disable prettier/prettier */
/** Pure helpers that turn a raw ActivityLog row into something a human (and a CSV) can read. */

const ACRONYMS: Record<string, string> = { seo: 'SEO', ip: 'IP', api: 'API', pos: 'POS', sms: 'SMS', cod: 'COD', fbr: 'FBR', b2b: 'B2B', '2fa': '2FA', url: 'URL', csv: 'CSV', ui: 'UI', id: 'ID' };

/** "seo_audit_run" → "SEO audit run", "login_failed" → "Login failed". */
export function actionTitle(action: string): string {
  const words = String(action || '').split('_').filter(Boolean).map((w) => ACRONYMS[w.toLowerCase()] ?? w.toLowerCase());
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function categoryTitle(category: string): string {
  const s = String(category || '').replace(/_/g, ' ');
  return ACRONYMS[s.toLowerCase()] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

export const HEX24 = /\b[a-f0-9]{24}\b/gi;

/** 24-char Mongo ids that appear after "Order #" — resolved to the customer-facing order number at read time. */
export function orderIdsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/Order #([a-f0-9]{24})\b/gi)) out.push(m[1]);
  return out;
}

/** Replaces raw internal ids in a description: "Order #<id>" → "Order #ORD-…", "checkout <id>" → "checkout #abc123". */
export function cleanDescription(text: string | null | undefined, orderNumbers: Map<string, string>): string | null {
  if (!text) return text ?? null;
  return text
    .replace(/Order #([a-f0-9]{24})\b/gi, (_m, id: string) => `Order #${orderNumbers.get(id) ?? id.slice(-6)}`)
    .replace(/\b(checkout|cart) ([a-f0-9]{24})\b/gi, (_m, w: string, id: string) => `${w} #${id.slice(-6)}`);
}

/** "2026-11-23 10:00:22" in the given IANA timezone (falls back to UTC for a bad/missing zone). */
export function formatInTimezone(date: Date | string, timeZone?: string | null): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const fmt = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  let parts;
  try { parts = fmt(timeZone || 'UTC'); } catch { parts = fmt('UTC'); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function safeTimezone(tz?: string | null): string {
  try { new Intl.DateTimeFormat('en', { timeZone: tz || 'UTC' }); return tz || 'UTC'; } catch { return 'UTC'; }
}

export interface ActivityChange { field: string; before?: unknown; after?: unknown }

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

/** "price: 10 → 12; status: draft → active" */
export function describeChanges(changes: unknown): string {
  if (!Array.isArray(changes)) return '';
  return (changes as ActivityChange[]).map((c) => `${c.field}: ${show(c.before)} → ${show(c.after)}`).join('; ');
}

/** Excel / Sheets treat a cell that starts with = + - @ as a formula — neutralise it (CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM + CRLF so Excel opens Urdu / accented text correctly. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Compact before/after diff between two plain objects over the listed fields. Only fields that really changed are returned. */
export function diffFields(before: Record<string, any> | null | undefined, after: Record<string, any> | null | undefined, fields: string[], max = 25): ActivityChange[] {
  const out: ActivityChange[] = [];
  const clip = (v: any) => {
    if (v && typeof v === 'object') { try { const j = JSON.stringify(v); return j.length > 200 ? `${j.slice(0, 200)}…` : v; } catch { return '[object]'; } }
    return typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  };
  for (const f of fields) {
    const a = before?.[f];
    const b = after?.[f];
    if (b === undefined) continue; // field not part of this update
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    out.push({ field: f, before: clip(a ?? null), after: clip(b ?? null) });
    if (out.length >= max) break;
  }
  return out;
}
