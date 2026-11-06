/* eslint-disable prettier/prettier */
import { isIP } from 'net';
import { isPrivateIp, isValidSmtpHostName } from '../notifications/smtp-host-guard.util';

/** Pure helpers for SMS marketing: segments, the opt-out line, request templating for a seller-configured HTTP gateway, and webhook mapping. */

export const STOP_FOOTER = 'Reply STOP to opt out';
export const MAX_SMS_TEXT = 500;

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

/** SMS parts a message will be billed as (GSM-7: 160 / 153 per part; anything else, e.g. Urdu, is UCS-2: 70 / 67 per part). */
export function smsSegments(text: string): { segments: number; encoding: 'GSM-7' | 'UCS-2'; length: number } {
  let units = 0; let gsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) units += 1;
    else if (GSM7_EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { segments: units <= 160 ? (units === 0 ? 0 : 1) : Math.ceil(units / 153), encoding: 'GSM-7', length: units };
  const len = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { segments: len <= 70 ? 1 : Math.ceil(len / 67), encoding: 'UCS-2', length: len };
}

/** Every marketing SMS carries the opt-out line (once). */
export const withStopFooter = (text: string): string => (text.includes(STOP_FOOTER) ? text : `${text.trimEnd()}\n${STOP_FOOTER}`);

export type RenderMode = 'raw' | 'json' | 'form' | 'url';
/** Fills {{to}}, {{text}}, {{sender}}, {{secret}} with the value escaped for where it lands. Unknown {{tags}} are left as they are. */
export function renderTemplate(template: string, vars: Record<string, string>, mode: RenderMode): string {
  const esc = (v: string) => (mode === 'json' ? JSON.stringify(v).slice(1, -1) : mode === 'form' || mode === 'url' ? encodeURIComponent(v) : v);
  return template.replace(/{{\s*(to|text|sender|secret)\s*}}/g, (_m, k: string) => esc(vars[k] ?? ''));
}

export function getPath(obj: unknown, path: string | null | undefined): string | null {
  if (!path) return null;
  let cur: any = obj;
  for (const part of path.split('.')) { if (cur == null || typeof cur !== 'object') return null; cur = cur[part]; }
  return cur == null ? null : String(cur).slice(0, 200);
}

export interface HttpSmsConfig {
  url: string;
  method: 'GET' | 'POST';
  contentType: 'json' | 'form';
  headers: Record<string, string>;
  body: string;
  /** If set, the response body must contain this text for the send to count as accepted (many gateways answer 200 with an error body). */
  successMatch: string | null;
  /** Dot path of the message id in a JSON response, for delivery reports. */
  messageIdPath: string | null;
}

/** Seller input check for a generic HTTP SMS gateway (the secret itself is stored separately, encrypted). */
export function validateHttpSmsConfig(c: Partial<HttpSmsConfig>): string | null {
  let u: URL;
  try { u = new URL(String(c.url ?? '').replace(/{{\s*\w+\s*}}/g, 'x')); } catch { return 'Enter the gateway URL'; }
  if (u.protocol !== 'https:') return 'The gateway URL must start with https://';
  if (u.username || u.password) return 'Do not put a user name or password in the URL; use the secret field';
  if (isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0 || !isValidSmtpHostName(u.hostname)) return 'The gateway URL must use a public host name (not an IP address)';
  if (!['GET', 'POST'].includes(String(c.method))) return 'Method must be GET or POST';
  if (!['json', 'form'].includes(String(c.contentType))) return 'Content type must be json or form';
  if (c.method === 'POST' && !String(c.body ?? '').includes('{{text}}')) return 'The request body must contain {{text}}';
  if (c.method === 'GET' && !String(c.url).includes('{{text}}')) return 'The URL must contain {{text}}';
  if (!String(c.url).includes('{{to}}') && !String(c.body ?? '').includes('{{to}}')) return 'The URL or body must contain {{to}} (the phone number)';
  const h = c.headers ?? {};
  if (typeof h !== 'object' || Array.isArray(h) || Object.keys(h).length > 10) return 'Headers must be a small set of name/value pairs';
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z0-9-]{1,50}$/.test(k) || typeof v !== 'string' || v.length > 300 || /[\r\n]/.test(v)) return 'A header name or value is not valid';
    if (/^(host|content-length|transfer-encoding|connection)$/i.test(k)) return `The header ${k} cannot be set`;
  }
  if (c.successMatch != null && (typeof c.successMatch !== 'string' || c.successMatch.length > 100)) return 'The success text is too long';
  if (c.messageIdPath != null && !/^[A-Za-z0-9_.]{1,80}$/.test(String(c.messageIdPath))) return 'The message id path is not valid';
  return null;
}

export { isPrivateIp };

// ── inbound / delivery webhook mapping ─────────────────────────────────────
/**
 * VERIFY AGAINST OFFICIAL DOC (each SMS gateway). Gateways differ; this accepts the common field names and nothing else. A gateway that
 * posts different fields needs its own mapping here once its documentation is available. Never an error: unknown shapes are ignored.
 */
const first = (o: any, keys: string[]): string | null => { for (const k of keys) if (o && o[k] != null && String(o[k]).trim()) return String(o[k]).trim(); return null; };

export function mapSmsInbound(body: any): { from: string; text: string } | null {
  const from = first(body, ['from', 'msisdn', 'sender', 'mobile', 'phone']);
  const text = first(body, ['text', 'message', 'body', 'content', 'sms']);
  return from && text ? { from, text } : null;
}

export function mapSmsDelivery(body: any): { id: string; status: 'delivered' | 'failed' | 'sent' } | null {
  const id = first(body, ['id', 'message_id', 'messageId', 'msgid', 'sms_id']);
  const raw = (first(body, ['status', 'dlr', 'state', 'delivery_status']) ?? '').toLowerCase();
  if (!id || !raw) return null;
  if (/^(delivered|deliv|delivrd|success|ok|1)$/.test(raw)) return { id, status: 'delivered' };
  if (/^(failed|fail|undelivered|undeliv|rejected|rejectd|expired|error|0|2)$/.test(raw)) return { id, status: 'failed' };
  if (/^(sent|submitted|accepted|queued)$/.test(raw)) return { id, status: 'sent' };
  return null;
}

/**
 * Pakistani gateways: NO endpoint or field is invented here. Each entry is a placeholder the seller completes from their own provider's
 * documentation through the generic HTTP gateway, until we have the official documentation / a sandbox (see OPEN-QUESTIONS).
 */
export const PK_GATEWAY_PRESETS: { key: string; label: string; verified: false; note: string }[] = [
  { key: 'pk_jazz', label: 'Jazz (corporate SMS)', verified: false, note: 'Paste the HTTPS API URL and parameters from your Jazz business SMS documentation.' },
  { key: 'pk_telenor', label: 'Telenor (corporate SMS)', verified: false, note: 'Paste the HTTPS API URL and parameters from your Telenor business SMS documentation.' },
  { key: 'pk_zong', label: 'Zong (corporate SMS)', verified: false, note: 'Paste the HTTPS API URL and parameters from your Zong business SMS documentation.' },
  { key: 'pk_ufone', label: 'Ufone (corporate SMS)', verified: false, note: 'Paste the HTTPS API URL and parameters from your Ufone business SMS documentation.' },
  { key: 'pk_aggregator', label: 'Other Pakistani SMS provider', verified: false, note: 'Any provider with an HTTPS API (bulk SMS aggregators): paste their API details.' },
];
