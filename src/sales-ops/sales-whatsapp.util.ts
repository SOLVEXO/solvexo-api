/* eslint-disable prettier/prettier */

/**
 * WhatsApp Cloud API helpers for Solvexo's own sales number. Pure functions; SalesWhatsAppService does the I/O.
 *
 * Meta's rule that shapes the inbox: a business may send free-form messages only within 24 hours of the person's
 * last message ("customer service window"). Outside it, only an approved template message can start the chat again.
 */

export const WINDOW_MS = 24 * 3_600_000;

export interface InboundMessage {
  waMessageId: string;
  from: string;
  name: string | null;
  type: string;
  text: string;
  at: Date;
}
export interface StatusUpdate {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error: string | null;
  at: Date;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** A readable line for any inbound message type (media are not downloaded; the inbox says what arrived). */
function textOf(m: any): string {
  switch (m?.type) {
    case 'text':
      return str(m.text?.body) ?? '';
    case 'button':
      return str(m.button?.text) ?? '[Button]';
    case 'interactive':
      return (
        str(m.interactive?.button_reply?.title) ??
        str(m.interactive?.list_reply?.title) ??
        '[Reply]'
      );
    case 'image':
    case 'video':
    case 'document': {
      const caption = str(m[m.type]?.caption) ?? str(m.document?.filename);
      return `[${m.type[0].toUpperCase()}${m.type.slice(1)}]${caption ? ` ${caption}` : ''}`;
    }
    case 'audio':
      return '[Voice message]';
    case 'sticker':
      return '[Sticker]';
    case 'location':
      return `[Location]${m.location?.name ? ` ${m.location.name}` : ''}`;
    case 'contacts':
      return '[Contact card]';
    case 'reaction':
      return `[Reacted ${str(m.reaction?.emoji) ?? ''}]`;
    default:
      return `[${str(m?.type) ?? 'Message'}]`;
  }
}

/** Every message and status in a webhook payload that belongs to `phoneNumberId`. */
export function parseWebhook(
  payload: any,
  phoneNumberId: string,
): { messages: InboundMessage[]; statuses: StatusUpdate[] } {
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value;
      if (str(v?.metadata?.phone_number_id) !== phoneNumberId) continue;
      const names = new Map<string, string>(
        (Array.isArray(v?.contacts) ? v.contacts : [])
          .filter((c: any) => str(c?.wa_id))
          .map((c: any) => [c.wa_id, str(c?.profile?.name) ?? '']),
      );
      for (const m of Array.isArray(v?.messages) ? v.messages : []) {
        const id = str(m?.id),
          from = str(m?.from);
        if (!id || !from || !/^\d{6,20}$/.test(from)) continue;
        messages.push({
          waMessageId: id,
          from,
          name: names.get(from) || null,
          type: str(m.type) ?? 'unknown',
          text: textOf(m).slice(0, 4000),
          at: new Date((Number(m.timestamp) || Date.now() / 1000) * 1000),
        });
      }
      for (const s of Array.isArray(v?.statuses) ? v.statuses : []) {
        const id = str(s?.id),
          st = str(s?.status);
        if (!id || !st || !['sent', 'delivered', 'read', 'failed'].includes(st))
          continue;
        const err =
          Array.isArray(s.errors) && s.errors[0]
            ? `${s.errors[0].title ?? ''}${s.errors[0].error_data?.details ? `: ${s.errors[0].error_data.details}` : ''}`.trim()
            : null;
        statuses.push({
          waMessageId: id,
          status: st as StatusUpdate['status'],
          error: err || null,
          at: new Date((Number(s.timestamp) || Date.now() / 1000) * 1000),
        });
      }
    }
  }
  return { messages, statuses };
}

/** Can a free-form message be sent now? */
export const windowOpen = (
  lastInboundAt: Date | string | null | undefined,
  now = Date.now(),
) => !!lastInboundAt && now - new Date(lastInboundAt).getTime() < WINDOW_MS;

/** WhatsApp wants international digits: 0300 1234567 → 923001234567 (Pakistan numbers written locally). */
export function toWaId(phone: string | null | undefined): string | null {
  let d = (phone ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = `92${d.slice(1)}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** Status only moves forward (a late "delivered" never overwrites "read"); "failed" always sticks. */
const RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};
export function nextStatus(current: string, incoming: string): string {
  if (incoming === 'failed') return 'failed';
  if (current === 'failed') return current;
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : current;
}

// ── Approved templates (restart a chat after the 24-hour window) ────────────

export interface WaTemplate {
  /** `name:lang`, unique in the list. */
  key: string;
  label: string;
  name: string;
  lang: string;
  /** The body has {{1}}, filled with the person's first name. */
  usesName: boolean;
  /** The approved body text, for the picker's preview. */
  body: string | null;
  /** Why it is sent (MESSAGE_REASONS). */
  reason: string;
}

export const MAX_WA_TEMPLATES = 20;
export const WA_TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
export const WA_TEMPLATE_LANG_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const waTemplateKey = (name: string, lang: string) => `${name}:${lang}`;

/** The saved list, or the one template saved before lists existed. */
export function templatesOf(s: any): WaTemplate[] {
  if (Array.isArray(s?.waTemplates) && s.waTemplates.length) return s.waTemplates.map((t: WaTemplate) => ({ ...t, reason: t.reason || 'follow_up' }));
  if (!s?.waTemplateName) return [];
  const lang = s.waTemplateLang || 'en';
  return [{ key: waTemplateKey(s.waTemplateName, lang), label: s.waTemplateName, name: s.waTemplateName, lang, usesName: !!s.waTemplateUsesName, body: null, reason: 'follow_up' }];
}

/**
 * Whether Solvexo can send this Meta template as it is: it fills only {{1}} in the body (the person's first name),
 * so a template needing anything else (other body variables, a header variable or media, a button parameter)
 * would be refused by Meta at send time. Returns the body text and whether it uses {{1}}, or the problem.
 */
export function checkMetaTemplate(components: any[]): { ok: true; body: string; usesName: boolean } | { ok: false; problem: string } {
  const list = Array.isArray(components) ? components : [];
  const vars = (t: unknown) => [...String(t ?? '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  const header = list.find((c) => String(c?.type).toUpperCase() === 'HEADER');
  if (header) {
    const format = String(header.format ?? 'TEXT').toUpperCase();
    if (format !== 'TEXT') return { ok: false, problem: `its header is ${format.toLowerCase()}, which needs a file for every send` };
    if (vars(header.text).length) return { ok: false, problem: 'its header has a variable' };
  }
  const bodyC = list.find((c) => String(c?.type).toUpperCase() === 'BODY');
  const body = String(bodyC?.text ?? '');
  const bodyVars = [...new Set(vars(body))];
  if (bodyVars.some((v) => v !== '1'))
    return { ok: false, problem: `its body uses ${bodyVars.map((v) => `{{${v}}}`).join(', ')}; Solvexo fills only {{1}} (the first name)` };
  for (const b of list.find((c) => String(c?.type).toUpperCase() === 'BUTTONS')?.buttons ?? []) {
    const type = String(b?.type ?? '').toUpperCase();
    if (!['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(type)) return { ok: false, problem: `it has a ${type.toLowerCase().replace(/_/g, ' ')} button` };
    if (type === 'URL' && vars(b?.url).length) return { ok: false, problem: 'a button link has a variable' };
  }
  return { ok: true, body: body.slice(0, 1024), usesName: bodyVars.includes('1') };
}
